import os
import glob
import json
import pandas as pd
import numpy as np
import xgboost as xgb
from sklearn.model_selection import train_test_split
from sklearn.metrics import mean_absolute_error, r2_score
from vaderSentiment.vaderSentiment import SentimentIntensityAnalyzer
from datetime import datetime, timezone
import re

vader = SentimentIntensityAnalyzer()

def parse_duration(duration_str):
    """
    Parses a YouTube ISO 8601 duration string (e.g., 'PT1M30S') and converts it into total seconds.
    
    Args:
        duration_str (str): The raw duration string from the YouTube API.
        
    Returns:
        int: Total duration in seconds.
    """
    if pd.isna(duration_str): return 0
    h_match = re.search(r'(\d+)H', duration_str)
    m_match = re.search(r'(\d+)M', duration_str)
    s_match = re.search(r'(\d+)S', duration_str)
    return (int(h_match.group(1)) * 3600 if h_match else 0) + \
           (int(m_match.group(1)) * 60 if m_match else 0) + \
           (int(s_match.group(1)) if s_match else 0)

def load_and_preprocess_data(data_dir="data"):
    """
    Loads raw YouTube CSV data from the given directory and performs advanced feature engineering.
    
    This function handles four main steps:
    1. Loading and combining all genre CSVs into one large dataset.
    2. Extracting Temporal Features (age in days, publish hour) to capture the YouTube algorithm's timing preferences.
    3. Extracting Text/Psychological Features (sentiment, caps ratio) to capture human clickbait psychology.
    4. Encoding Target Variables (log-transformed view counts) so the model predicts magnitude.
    
    Args:
        data_dir (str): Path to the directory containing the CSV files.
        
    Returns:
        tuple: (X, y, features) where X is the feature DataFrame, y is the target Series, 
               and features is a list of the column names.
    """
    all_files = glob.glob(os.path.join(data_dir, "*.csv"))
    df_list = []
    
    """
    Load all CSV files. We also extract the "genre" directly from the filename 
    so we know if a video is 'comedy' or 'gaming', which heavily affects views.
    """
    for f in all_files:
        df = pd.read_csv(f)
        df['genre'] = os.path.basename(f).replace("_videos.csv", "")
        df_list.append(df)
        
    # Combine everything and drop any rows that are missing the core viewCount or publishedAt data.
    df = pd.concat(df_list, ignore_index=True).dropna(subset=['viewCount', 'publishedAt'])
    
    """
    ---------------------------------------------
    FEATURE ENGINEERING STEP 1: Temporal Features
    ---------------------------------------------
    We calculate how old the video is in days (`age_in_days`). This is critical because 
    older videos naturally accumulate more views. We also extract `publish_hour` because 
    videos posted at 5 PM often perform differently than videos posted at 3 AM.
    """
    df['publishedAt'] = pd.to_datetime(df['publishedAt'])
    df['age_in_days'] = (datetime.now(timezone.utc) - df['publishedAt']).dt.total_seconds() / (24 * 3600)
    df['age_in_days'] = df['age_in_days'].clip(lower=1)
    df['publish_hour'] = df['publishedAt'].dt.hour
    
    """
    --------------------------------------------------
    FEATURE ENGINEERING STEP 2: Psychological Features
    --------------------------------------------------
    These features try to measure "Clickbait-iness". 
    - `title_length`: Are shorter, punchy titles better?
    - `title_caps_ratio`: Percentage of uppercase letters (e.g. "OMG THIS IS CRAZY")
    - `title_sentiment`: We use VADER to score the emotional intensity of the title.
    """
    df['title_length'] = df['title'].astype(str).apply(len)
    df['title_caps_ratio'] = df['title'].apply(lambda x: sum(1 for c in str(x) if c.isupper()) / len(str(x)) if len(str(x)) > 0 else 0)
    df['title_sentiment'] = df['title'].apply(lambda x: vader.polarity_scores(str(x))['compound'])
    
    """
    --------------------------------------------------
    FEATURE ENGINEERING STEP 3: Content Features
    --------------------------------------------------
    - `duration_seconds`: Shorter videos might get more replay value.
    - `tags_count`: Does stuffing tags into the video help the algorithm find it?
    - `genre`: We "One-Hot Encode" the genre. This splits 'genre' into multiple 
      boolean columns (e.g. genre_comedy=1, genre_gaming=0) because XGBoost prefers numbers.
    """
    df['duration_seconds'] = df['duration'].apply(parse_duration)
    df['tags_count'] = df['tags'].apply(lambda x: len(str(x).split(',')) if str(x) != '[]' else 0)
    
    df = pd.get_dummies(df, columns=['genre'], prefix='genre')
    for col in df.columns:
        if df[col].dtype == bool: df[col] = df[col].astype(int)
            
    """
    --------------------------------------------------
    FEATURE ENGINEERING STEP 4: Target Variable
    --------------------------------------------------
    We predict log1p(viewCount) instead of raw viewCount. 
    Because YouTube views are heavily skewed (a few videos have millions, most have hundreds),
    predicting logarithms helps the model understand the "magnitude" of success instead of 
    being distracted by massive outliers.
    """
    df['target_log_views'] = np.log1p(df['viewCount'])
    
    # Collect all the final feature columns we created to pass to the model.
    features = ['age_in_days', 'publish_hour', 'title_length', 'title_caps_ratio', 'title_sentiment', 'duration_seconds', 'tags_count']
    features.extend([c for c in df.columns if c.startswith('genre_')])
    
    # Drop any remaining rows that have NaN (Not a Number) values in our features.
    df = df.dropna(subset=features + ['target_log_views'])
    return df[features], df['target_log_views'], features

if __name__ == "__main__":
    print("Extracting deep features from CSVs...")
    data_dir = os.path.join(os.path.dirname(__file__), 'data')
    X, y, feature_names = load_and_preprocess_data(data_dir=data_dir)
    
    

    """
    1. TRAIN / TEST SPLIT
    We take all our data (X=features, y=target) and split it.
    test_size=0.2 means 80% is used to train the model, and 20% 
    is hidden away to test it later (to ensure it isn't just memorizing).
    """
    X_train, X_test, y_train, y_test = train_test_split(
        X, 
        y, 
        test_size=0.2,      
        random_state=42,    
    )
    
    print(f"Training XGBoost Regressor...")
    """
    2. MODEL INITIALIZATION
    XGBoost is an algorithm that builds hundreds of "decision trees".
    n_estimators=150: Build 150 sequential trees.
    max_depth=6: Each tree can ask up to 6 Yes/No questions.
    """
    model = xgb.XGBRegressor(n_estimators=150, learning_rate=0.1, max_depth=6)
    
    """
    3. MODEL FITTING (TRAINING)
    The model looks at the 80% training data (X_train) and tries 
    to learn the patterns that lead to the view counts (y_train).
    """
    model.fit(X_train, y_train)

    """
    4. PREDICTIONS (TESTING)
    Now we give the model the 20% test data (X_test) it has NEVER seen, 
    and ask it to guess the view counts based on what it learned.
    """
    predictions = model.predict(X_test)
    
    """
    5. METRICS (EVALUATION)
    Mean Absolute Error (MAE) measures how far off the model's guesses 
    were from the actual, real view counts (y_test) on average.
    """
    mae = mean_absolute_error(y_test, predictions)
    print(f"Test MAE (Log Views): {mae:.4f}")
    
    """
    6. SAVE MODEL
    Save the trained "brain" to a file so our Go backend can load it.
    """
    model_path = os.path.join(os.path.dirname(__file__), 'model.json')
    model.save_model(model_path)

    
    schema_path = os.path.join(os.path.dirname(__file__), 'feature_schema.json')
    with open(schema_path, 'w') as f:
        json.dump(feature_names, f)
    print(f"✅ Saved feature schema to: {schema_path}")
