import os
import requests
from dotenv import load_dotenv

load_dotenv()

PEXELS_API_KEY = os.getenv("PEXELS_API_KEY")

def search_stock_videos(query, min_duration=5, orientation="landscape"):
    """
    Search Pexels API for stock videos matching the query.
    """
    if not PEXELS_API_KEY:
        raise ValueError("PEXELS_API_KEY is not set in .env")

    url = "https://api.pexels.com/videos/search"
    headers = {
        "Authorization": PEXELS_API_KEY
    }
    params = {
        "query": query,
        "per_page": 5, # Just get top 5 to keep it fast
        "orientation": orientation
    }

   
    response = requests.get(url, headers=headers, params=params)

    if response.status_code != 200:
        print(f"Error: Pexels API returned status code {response.status_code}")
        return []
        
    data = response.json()

    videos = []
    
     
    for vid in data.get("videos", []):
        if vid.get("duration", 0) >= min_duration:
            hd_link = get_hd_link(vid)
            if hd_link:
                videos.append({
                    "id": vid.get("id"),
                    "duration": vid.get("duration"),
                    "link": hd_link
                })

    return videos


def get_hd_link(video_data):
    """
    Helper function to dig through Pexels nested JSON and find the first HD quality link.
    """
    video_files = video_data.get("video_files", [])
    for file in video_files:
        if file.get("quality") == "hd":
            return file.get("link")
    
    # Fallback to the first file if no HD found
    if video_files:
        return video_files[0].get("link")
    return None

if __name__ == "__main__":
    # Test block
    print("Searching for: dark haunted house...")
    results = search_stock_videos("dark haunted house")
    for r in results:
        print(f"- Video ID {r['id']} ({r['duration']}s): {r['link'][:50]}...")
