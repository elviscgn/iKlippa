from fastapi import FastAPI
from pydantic import BaseModel
import uvicorn
import os
from dotenv import load_dotenv

from scripts.parse_script import parse_script
from scripts.stock_search import search_stock_videos
from scripts.music_search import search_background_music

load_dotenv()
app = FastAPI(title="iKlippa ML Engine")

class ScriptRequest(BaseModel):
    script_text: str

class AnalysisResponse(BaseModel):
    keywords: list[str]
    mood: dict
    pacing: dict
    stock_videos: list
    background_music: list

@app.post("/analyze", response_model=AnalysisResponse)
async def analyze_script(req: ScriptRequest):
    script_extraction = parse_script(req.script_text)

    first_keyword = script_extraction["keywords"][0] if script_extraction["keywords"] else "cinematic"
    videos = search_stock_videos(first_keyword)

    mood_label = script_extraction["mood"]["label"]
    background_music = search_background_music(mood_label)

    return AnalysisResponse(
        keywords=script_extraction["keywords"],
        mood= script_extraction["mood"],
        pacing=script_extraction["pacing"],
        stock_videos=videos,
        background_music = background_music
    )

if __name__ == "__main__":
    print("Starting FastAPI ML Server on port 8000")
    uvicorn.run("app:app", host="0.0.0.0", port=8000, reload=True)
