import os
import requests
from dotenv import load_dotenv

load_dotenv()

JAMENDO_CLIENT_ID = os.getenv("JAMENDO_CLIENT_ID")

def search_background_music(tags, limit=3):
    """
    Search Jamendo API for background music matching the mood tags.
    """
    if not JAMENDO_CLIENT_ID:
        raise ValueError("JAMENDO_CLIENT_ID is not set in .env")

    url = "https://api.jamendo.com/v3.0/tracks/"
    
    # Jamendo uses client_id in the params instead of headers
    params = {
        "client_id": JAMENDO_CLIENT_ID,
        "format": "json",
        "tags": tags,     # e.g., "dark, cinematic"
        "limit": limit,
        "include": "musicinfo",
        "audioformat": "mp32"
    }

    response = requests.get(url=url, params=params)

    if response.status_code != 200:
        print(f"Error: Jamendo API returned status code {response.status_code}")
        return []
    
    data = response.json()

    tracks = []
    
   

    for track in data.get("results", []):
        tracks.append({
            "id":track.get("id"),
            "name":track.get("name"),
            "duration": track.get("duration"),
            "audio":track.get("audio")
        })

    return tracks

if __name__ == "__main__":
    # Test block
    print("Searching for: dark cinematic music...")
    results = search_background_music("dark, cinematic")
    for r in results:
            print(f"- Track ID {r['id']} ({r['duration']}s): {r['name']} -> {r['audio']}")
