# iKlippa

## Quickstart Installation Guide (Backend & ML)

This guide will help you spin up the entire 3-tier backend microservice architecture on your local machine in just a few minutes.

### Prerequisites
- [Python 3.10+](https://www.python.org/downloads/)
- [Go 1.21+](https://go.dev/doc/install)
- [Ollama](https://ollama.com/download)

### Step 1: Set up the Environment Variables

Copy the template and fill in your API keys:

```bash
cp ml/.env.example ml/.env
```

Then edit `ml/.env` with your keys:
```ini
PEXELS_API_KEY=your_pexels_key_here
JAMENDO_CLIENT_ID=your_jamendo_client_id_here
```

### Step 2: Start the AI Model (Service 1 of 3)

```bash
ollama run granite-code:3b
```

### Step 3: Start the Python ML Engine (Service 2 of 3)

```bash
cd ml
python -m venv venv
source venv/bin/activate
pip install -r requirements.txt
python app.py
```

### Step 4: Start the Go API Gateway (Service 3 of 3)

```bash
cd backend
go mod tidy
go run main.go
```

### You're Done!

Test the full pipeline:

```bash
curl -X POST http://localhost:8080/api/director/generate \
  -H "Content-Type: application/json" \
  -d '{"prompt": "A beautiful documentary about space."}'
```

### ML Engine Endpoints

| Method | Path | Description |
|--------|------|-------------|
| POST | `/analyze` | Analyze script text → keywords, mood, pacing, stock videos, music, virality score |
| POST | `/virality` | Predict virality from explicit feature values (age, duration, sentiment, genre, etc.) |

The virality model is a pre-trained XGBoost regressor (150 trees) that predicts expected view count from YouTube-style metadata. The `/analyze` endpoint derives reasonable defaults from the script text; the `/virality` endpoint accepts explicit values for full control.
