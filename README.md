# iKlippa

## Quickstart Installation Guide (Backend & ML)

This guide will help you spin up the entire 3-tier backend microservice architecture on your local machine in just a few minutes. All you need to do is copy and paste the commands in order.

### Prerequisites
Before you start, make sure you have the following installed on your machine:
*   [Python 3.10+](https://www.python.org/downloads/)
*   [Go 1.21+](https://go.dev/doc/install)
*   [Ollama](https://ollama.com/download)

### Step 1: Set up the Environment Variables
You need two API keys for the media engines. Inside the `ml/` folder, create a file called `.env` and paste your keys inside:
```ini
PEXELS_API_KEY=your_pexels_key_here
JAMENDO_CLIENT_ID=your_jamendo_client_id_here
```

### Step 2: Start the AI Model (Service 1 of 3)
We use the open-source IBM Granite model running locally so we don't have to deal with cloud IAM tokens.
Open a new terminal and run:
```bash
ollama run granite-code:3b
```
*(Leave this terminal window open in the background!)*

### Step 3: Start the Python ML Engine (Service 2 of 3)
This service handles all the NLP analysis and media fetching.
Open a **second** terminal, navigate to the project root, and run:
```bash
cd ml
python -m venv venv

# Activate the virtual environment (Windows)
.\venv\Scripts\activate
# OR (Mac/Linux)
# source venv/bin/activate

# Install the required packages
pip install -r requirements.txt
pip install fastapi uvicorn

# Start the Python server
python app.py
```
*(Leave this terminal window open in the background!)*

### Step 4: Start the Go API Gateway (Service 3 of 3)
This is the main orchestration server that the React frontend will talk to.
Open a **third** terminal, navigate to the project root, and run:
```bash
cd backend
go mod tidy
go run main.go
```
*(Leave this terminal window open in the background!)*

### You're Done!
All three backend microservices are now humming together. You can test the entire pipeline by opening a 4th terminal and firing a POST request:

```bash
curl -X POST http://localhost:8080/api/director/generate \
-H "Content-Type: application/json" \
-d "{\"prompt\": \"A beautiful documentary about space.\"}"
```
