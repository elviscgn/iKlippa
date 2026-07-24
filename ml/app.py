import json
import os
import re
import numpy as np
import xgboost as xgb
from fastapi import FastAPI
from pydantic import BaseModel
import uvicorn
from dotenv import load_dotenv

from scripts.parse_script import parse_script
from scripts.stock_search import search_stock_videos
from scripts.music_search import search_background_music

load_dotenv()
app = FastAPI(title="iKlippa ML Engine")

MODEL_PATH = os.path.join(os.path.dirname(__file__), "model.json")
FEATURE_SCHEMA_PATH = os.path.join(os.path.dirname(__file__), "feature_schema.json")

virality_model = None
feature_names: list[str] = []

try:
    virality_model = xgb.XGBRegressor()
    virality_model.load_model(MODEL_PATH)
    with open(FEATURE_SCHEMA_PATH) as f:
        feature_names = json.load(f)
    print(f"Loaded XGBoost virality model ({len(feature_names)} features)")
except Exception as e:
    print(f"WARNING: Could not load virality model: {e}")

class ScriptRequest(BaseModel):
    script_text: str

class ViralityRequest(BaseModel):
    age_in_days: float = 365.0
    publish_hour: int = 14
    title_length: int = 50
    title_caps_ratio: float = 0.1
    title_sentiment: float = 0.0
    duration_seconds: int = 300
    tags_count: int = 3
    genre: str = ""

class AnalysisResponse(BaseModel):
    keywords: list[str]
    mood: dict
    pacing: dict
    stock_videos: list
    background_music: list
    virality_score: float | None = None

def derive_virality_features(script_text: str, keywords: list, mood: dict) -> dict:
    from vaderSentiment.vaderSentiment import SentimentIntensityAnalyzer
    vader = SentimentIntensityAnalyzer()
    sentiment = vader.polarity_scores(script_text)["compound"]
    return dict(
        age_in_days=365.0,
        publish_hour=14,
        title_length=len(script_text),
        title_caps_ratio=sum(1 for c in script_text if c.isupper()) / max(len(script_text), 1),
        title_sentiment=sentiment,
        duration_seconds=max(30, len(script_text.split()) * 2),
        tags_count=len(keywords),
    )

def predict_virality(features: dict) -> float | None:
    if virality_model is None or not feature_names:
        return None
    row = np.zeros(len(feature_names))
    for i, name in enumerate(feature_names):
        if name.startswith("genre_"):
            genre = features.get("genre", "")
            row[i] = 1.0 if name == f"genre_{genre.lower()}" else 0.0
        else:
            row[i] = features.get(name, 0.0)
    log_views = float(virality_model.predict(row.reshape(1, -1))[0])
    return round(float(np.expm1(log_views)), 0)

@app.post("/analyze", response_model=AnalysisResponse)
async def analyze_script(req: ScriptRequest):
    script_extraction = parse_script(req.script_text)

    first_keyword = script_extraction["keywords"][0] if script_extraction["keywords"] else "cinematic"
    videos = search_stock_videos(first_keyword)

    mood_label = script_extraction["mood"]["label"]

    jamendo_tag_map = {
        "dark": "suspense",
        "neutral": "chill",
        "uplifting": "upbeat"
    }
    mood_label = jamendo_tag_map.get(mood_label, "chill")
    script_extraction["mood"]["label"] = mood_label

    background_music = search_background_music(mood_label)

    features = derive_virality_features(req.script_text, script_extraction["keywords"], script_extraction["mood"])
    virality_score = predict_virality(features)

    return AnalysisResponse(
        keywords=script_extraction["keywords"],
        mood=script_extraction["mood"],
        pacing=script_extraction["pacing"],
        stock_videos=videos,
        background_music=background_music,
        virality_score=virality_score,
    )

@app.post("/virality")
async def predict_virality_endpoint(req: ViralityRequest):
    score = predict_virality(req.model_dump())
    return {"virality_score": score, "estimated_views": score}

if __name__ == "__main__":
    print("Starting FastAPI ML Server on port 8000")
    uvicorn.run("app:app", host="0.0.0.0", port=8000, reload=True)
