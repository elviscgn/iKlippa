import os
import requests
from dotenv import load_dotenv

load_dotenv()

PEXELS_API_KEY = os.getenv("PEXELS_API_KEY")
PEXELS_SEARCH_URL = "https://api.pexels.com/videos/search"
REQUEST_TIMEOUT_SECONDS = 15


def search_stock_videos(query, min_duration=5, orientation="landscape", limit=8):
    """
    Search Pexels and normalize results for the editor's media pool.
    """
    if not PEXELS_API_KEY:
        raise ValueError("PEXELS_API_KEY is not set in .env")

    headers = {"Authorization": PEXELS_API_KEY}
    params = {
        "query": query,
        "per_page": max(1, min(limit, 20)),
        "orientation": orientation,
    }

    response = requests.get(
        PEXELS_SEARCH_URL,
        headers=headers,
        params=params,
        timeout=REQUEST_TIMEOUT_SECONDS,
    )
    response.raise_for_status()
    data = response.json()

    videos = []
    for vid in data.get("videos", []):
        if vid.get("duration", 0) >= min_duration:
            hd_link = get_hd_link(vid)
            if hd_link:
                user = vid.get("user") or {}
                videos.append({
                    "id": str(vid.get("id")),
                    "name": f"{query.strip().title()} {vid.get('id')}",
                    "duration": vid.get("duration"),
                    "video_url": hd_link,
                    "thumbnail_url": vid.get("image"),
                    "width": vid.get("width"),
                    "height": vid.get("height"),
                    "provider": "Pexels",
                    "creator": user.get("name"),
                    "page_url": vid.get("url"),
                })

    return videos


def get_hd_link(video_data):
    """
    Prefer a browser-friendly MP4 up to 1080p instead of an oversized 4K file.
    """
    video_files = [
        item
        for item in video_data.get("video_files", [])
        if item.get("link") and item.get("file_type") == "video/mp4"
    ]
    if not video_files:
        return None

    browser_sized = [
        item
        for item in video_files
        if item.get("quality") == "hd" and 720 <= (item.get("width") or 0) <= 1920
    ]
    candidates = browser_sized or video_files
    selected = min(
        candidates,
        key=lambda item: abs((item.get("width") or 1280) - 1280),
    )
    return selected.get("link")

if __name__ == "__main__":
    print("Searching for: dark haunted house...")
    results = search_stock_videos("dark haunted house")
    for r in results:
        print(f"- Video ID {r['id']} ({r['duration']}s): {r['video_url'][:50]}...")
