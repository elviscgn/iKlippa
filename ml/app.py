from fastapi import FastAPI
from pydantic import BaseModel
import uvicorn
import os
from dotenv import load_dotenv

from scripts.parse_script import parse_script
from scripts.stock_search import PexelsClient
from scripts.music_search import JamendoClient

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


