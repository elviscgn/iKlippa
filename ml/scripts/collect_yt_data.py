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
        default="action",
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
        video_id.append(item["videoId"])
        
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
        model_variables.append(item["videoId"])
        model_variables.append(item["title"])
        model_variables.append(item["description"])
        model_variables.append(item.get("tags", {}))
        model_variables.append(item["duration"])
        model_variables.append(item["viewCount"])
        model_variables.append(item["likeCount"])
        model_variables.append(item["commentCount"])
        
except Exception as e:
    print(f"An error occurred: {e}")


df = pd.DataFrame(model_variables)

df.to_csv(f"../data/{args.genre}_videos.csv", index=False)
