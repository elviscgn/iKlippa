import os
import requests
from dotenv import load_dotenv

load_dotenv()

JAMENDO_CLIENT_ID = os.getenv("JAMENDO_CLIENT_ID")
JAMENDO_TRACKS_URL = "https://api.jamendo.com/v3.0/tracks/"
REQUEST_TIMEOUT_SECONDS = 15


def search_background_music(tags, limit=8):
    """
    Search Jamendo and normalize results for the editor's media pool.
    """
    if not JAMENDO_CLIENT_ID:
        raise ValueError("JAMENDO_CLIENT_ID is not set in .env")

    params = {
        "client_id": JAMENDO_CLIENT_ID,
        "format": "json",
        "tags": tags,
        "limit": max(1, min(limit, 20)),
        "include": "musicinfo",
        "audioformat": "mp32",
    }

    response = requests.get(
        url=JAMENDO_TRACKS_URL,
        params=params,
        timeout=REQUEST_TIMEOUT_SECONDS,
    )
    response.raise_for_status()
    data = response.json()
    response_headers = data.get("headers") or {}
    if response_headers.get("status") == "failed":
        raise ValueError(
            "JAMENDO_CLIENT_ID was rejected by Jamendo. Check that the client ID is authorized."
        )

    tracks = []
    for track in data.get("results", []):
        tracks.append({
            "id": str(track.get("id")),
            "name": track.get("name"),
            "duration": track.get("duration"),
            "audio_url": track.get("audio"),
            "thumbnail_url": track.get("album_image"),
            "provider": "Jamendo",
            "creator": track.get("artist_name"),
            "page_url": track.get("shareurl"),
        })

    return tracks

if __name__ == "__main__":
    print("Searching for: dark cinematic music...")
    results = search_background_music("dark, cinematic")
    for r in results:
        print(f"- Track ID {r['id']} ({r['duration']}s): {r['name']} -> {r['audio_url']}")
