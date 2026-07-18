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

#     {
#     "keywords": ["dark figure", "abandoned hospital"], # <-- This is the list!
#     "mood": {"compound": -0.8, "label": "dark"},
#     "pacing": {"avg_words_per_sentence": 5.0, "label": "fast"}
# }

    first_keyword = script_extraction["keywords"][0] if script_extraction["keywords"] else "cinematic"
    videos = search_stock_videos(first_keyword)





    # TODO 3: Search for background music
    # Grab the mood label.
    # e.g., mood_label = script_extraction["mood"]["label"]
    # Then call search_background_music() with it.

    # TODO 4: Return an AnalysisResponse with all the data plugged in!
    # return AnalysisResponse(
    #     keywords=script_extraction["keywords"],
    #     mood=script_extraction["mood"],
    #     ...
    # )
    pass

if __name__ == "__main__":
    print("Starting FastAPI ML Server on port 8000")
    uvicorn.run("app:app", host="0.0.0.0", port=8000, reload=True)
