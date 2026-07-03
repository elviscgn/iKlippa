import argparse
import os
import pandas as pd
from dotenv import load_dotenv
from googleapiclient.discovery import build

load_dotenv()

api_key = os.getenv("YOUTUBE_API_KEY")

youtube = build('youtube', 'v3', developerKey=api_key)

parser = argparse.ArgumentParser(
        description="Search for media content by text query and genre filter."
    )

parser.add_argument(
        "query", 
        type=str, 
        help="The text search term "
    )

parser.add_argument(
        "-g", "--genre",
        type=str,
        choices=["gaming", "music", "comedy", "science", "horror", "crime"],
        default="comedy",
        help="Filter results by a specific genre. (default: %(default)s)"
    )

args = parser.parse_args()


request = youtube.search().list(
    q=args.query,
    part="id,snippet",
    type="video",
    videoDuration="short",
    maxResults=50
)
video_id = []
try:
    response = request.execute()
    
    for item in response.get("items", []):
        video_id.append(item["id"]["videoId"])
        
except Exception as e:
    print(f"An error occurred: {e}")

video_request = youtube.videos().list(
    id=",".join(video_id),
    part = "snippet,contentDetails,statistics"

)

model_variables = []
try:
    response = video_request.execute()
    
    for item in response.get("items", []):
        model_variables.append({
            "videoId":item["id"],
            "title":item["snippet"]["title"],
            "description": item["snippet"]["description"],
            "tags": item["snippet"].get("tags", {}),
            "duration":item["contentDetails"]["duration"],
           "viewCount": item["statistics"].get("viewCount", 0),
            "likeCount": item["statistics"].get("likeCount", 0),
            "commentCount": item["statistics"].get("commentCount", 0)

        })
        
except Exception as e:
    print(f"An error occurred: {e}")


df = pd.DataFrame(model_variables)

df.to_csv(f"data/{args.genre}_videos.csv", index=False)
