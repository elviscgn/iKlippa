import argparse
import os
import pandas as pd
from dotenv import load_dotenv
from googleapiclient.discovery import build

load_dotenv(dotenv_path=os.path.join(os.path.dirname(__file__), '..', '.env'))
api_key = os.getenv("YOUTUBE_API_KEY")
youtube = build('youtube', 'v3', developerKey=api_key)

parser = argparse.ArgumentParser(
    description="Collect YouTube Shorts metadata for XGBoost training data."
)
parser.add_argument(
    "query",
    type=str,
    help="The YouTube search query (e.g., 'horror', 'gaming', 'comedy')."
)
parser.add_argument(
    "-g", "--genre",
    type=str,
    choices=["gaming", "music", "comedy", "science", "horror", "crime"],
    default="comedy",
    help="Genre label for the output CSV filename. (default: %(default)s)"
)
parser.add_argument(
    "-n", "--max-results",
    type=int,
    default=500,
    help="Maximum number of videos to collect. (default: %(default)s)"
)
args = parser.parse_args()

# --- Step 1: Search for video IDs with pagination ---
video_ids = []
next_page_token = None
print(f"Searching for '{args.query}' (genre: {args.genre})...")

while len(video_ids) < args.max_results:
    try:
        request = youtube.search().list(
            q=args.query,
            part="id",
            type="video",
            videoDuration="short",
            order="viewCount",
            maxResults=50,
            pageToken=next_page_token
        )
        response = request.execute()

        for item in response.get("items", []):
            video_ids.append(item["id"]["videoId"])

        next_page_token = response.get("nextPageToken")
        print(f"  Collected {len(video_ids)} video IDs so far...")

        if not next_page_token:
            break

    except Exception as e:
        print(f"Search error: {e}")
        break

# Trim to the exact max
video_ids = video_ids[:args.max_results]
print(f"Total video IDs collected: {len(video_ids)}")

# --- Step 2: Fetch full metadata in batches of 50 ---
all_videos = []

# videos.list accepts max 50 IDs at a time
for i in range(0, len(video_ids), 50):
    batch = video_ids[i:i + 50]
    try:
        video_request = youtube.videos().list(
            id=",".join(batch),
            part="snippet,contentDetails,statistics"
        )
        response = video_request.execute()

        for item in response.get("items", []):
            all_videos.append({
                "videoId": item["id"],
                "title": item["snippet"]["title"],
                "description": item["snippet"]["description"],
                "tags": item["snippet"].get("tags", []),
                "channelTitle": item["snippet"]["channelTitle"],
                "channelId": item["snippet"]["channelId"],
                "publishedAt": item["snippet"]["publishedAt"],
                "duration": item["contentDetails"]["duration"],
                "viewCount": int(item["statistics"].get("viewCount", 0)),
                "likeCount": int(item["statistics"].get("likeCount", 0)),
                "commentCount": int(item["statistics"].get("commentCount", 0)),
            })

        print(f"  Fetched metadata for {len(all_videos)} videos...")

    except Exception as e:
        print(f"Metadata fetch error: {e}")

# --- Step 3: Deduplicate by channel (keep highest viewCount per creator) ---
df = pd.DataFrame(all_videos)

if not df.empty:
    before_dedup = len(df)
    df = df.sort_values("viewCount", ascending=False)
    df = df.groupby("channelId").head(3)
    after_dedup = len(df)
    print(f"Deduplicated: {before_dedup} -> {after_dedup} videos (removed {before_dedup - after_dedup} duplicates)")

# --- Step 4: Save to CSV ---
os.makedirs("data", exist_ok=True)
output_path = f"data/{args.genre}_videos.csv"
df.to_csv(output_path, index=False)
print(f"Saved {len(df)} videos to {output_path}")
