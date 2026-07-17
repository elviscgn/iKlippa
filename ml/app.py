from fastapi import FastAPI
from pydantic import BaseModel
import uvicorn
import os
from dotenv import load_dotenv

from scripts.parse_script import parse_script
from scripts.stock_search import PexelsClient
from scripts.music_search import JamendoClient
