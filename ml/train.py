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
    if pd.isna(duration_str): return 0
    h_match = re.search(r'(\d+)H', duration_str)
    m_match = re.search(r'(\d+)M', duration_str)
    s_match = re.search(r'(\d+)S', duration_str)
    return (int(h_match.group(1)) * 3600 if h_match else 0) + \
           (int(m_match.group(1)) * 60 if m_match else 0) + \
           (int(s_match.group(1)) if s_match else 0)

def load_and_preprocess_data(data_dir="data"):
    all_files = glob.glob(os.path.join(data_dir, "*.csv"))
    df_list = []
    for f in all_files:
        df = pd.read_csv(f)
        df['genre'] = os.path.basename(f).replace("_videos.csv", "")
        df_list.append(df)
        
    df = pd.concat(df_list, ignore_index=True).dropna(subset=['viewCount', 'publishedAt'])
    
    # 1. Temporal
    df['publishedAt'] = pd.to_datetime(df['publishedAt'])
    df['age_in_days'] = (datetime.now(timezone.utc) - df['publishedAt']).dt.total_seconds() / (24 * 3600)
    df['age_in_days'] = df['age_in_days'].clip(lower=1)
    df['publish_hour'] = df['publishedAt'].dt.hour
    
    # 2. Text/Psychological
    df['title_length'] = df['title'].astype(str).apply(len)
    df['title_caps_ratio'] = df['title'].apply(lambda x: sum(1 for c in str(x) if c.isupper()) / len(str(x)) if len(str(x)) > 0 else 0)
    df['title_sentiment'] = df['title'].apply(lambda x: vader.polarity_scores(str(x))['compound'])
    
    # 3. Content
    df['duration_seconds'] = df['duration'].apply(parse_duration)
    df['tags_count'] = df['tags'].apply(lambda x: len(str(x).split(',')) if str(x) != '[]' else 0)
    
    # One-hot encode genre
    df = pd.get_dummies(df, columns=['genre'], prefix='genre')
    for col in df.columns:
        if df[col].dtype == bool: df[col] = df[col].astype(int)
            
    df['target_log_views'] = np.log1p(df['viewCount'])
    
    features = ['age_in_days', 'publish_hour', 'title_length', 'title_caps_ratio', 'title_sentiment', 'duration_seconds', 'tags_count']
    features.extend([c for c in df.columns if c.startswith('genre_')])
    
    df = df.dropna(subset=features + ['target_log_views'])
    return df[features], df['target_log_views'], features

if __name__ == "__main__":
    print("Extracting deep features from CSVs...")
    data_dir = os.path.join(os.path.dirname(__file__), 'data')
    X, y, feature_names = load_and_preprocess_data(data_dir=data_dir)
    
    # TODO 1: Use `train_test_split` to split X and y into:
    # X_train, X_test, y_train, y_test
    # Set test_size=0.2 and random_state=42
    
    
    print(f"Training XGBoost Regressor...")
    # TODO 2: Initialize the XGBoost model
    # model = xgb.XGBRegressor(n_estimators=150, learning_rate=0.1, max_depth=6)
    
    
    # TODO 3: Fit the model on your training data
    # model.fit(...)
    
    
    # TODO 4: Make predictions on your test data
    # predictions = model.predict(...)
    
    
    # Metrics (Already written for you)
    mae = mean_absolute_error(y_test, predictions)
    print(f"Test MAE (Log Views): {mae:.4f}")
    
    # TODO 5: Save the model to `ml/model.json`
    # model_path = os.path.join(os.path.dirname(__file__), 'model.json')
    # Use model.save_model(...) to save it
    
    
    # Save feature schema for Go (Already written for you)
    schema_path = os.path.join(os.path.dirname(__file__), 'feature_schema.json')
    with open(schema_path, 'w') as f:
        json.dump(feature_names, f)
    print(f"✅ Saved feature schema to: {schema_path}")
