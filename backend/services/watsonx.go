package services

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io/ioutil"
	"net/http"
	"time"
)

// WatsonxClient now acts as our local Ollama client to run IBM Granite
type WatsonxClient struct {
	HttpClient *http.Client
}

// NewWatsonxClient creates a new client to talk to local Ollama
func NewWatsonxClient() *WatsonxClient {
	return &WatsonxClient{
		// Local LLMs running on CPU/Laptop GPUs can take 10-30 seconds to reply!
		HttpClient: &http.Client{Timeout: 60 * time.Second},
	}
}

// GenerateText asks the local Granite LLM to act as our "Director"
func (c *WatsonxClient) GenerateText(prompt string) (string, error) {
	// Ollama's default local generation endpoint
	ollamaURL := "http://localhost:11434/api/generate"

	type OllamaRequest struct {
		Model  string `json:"model"`
		Prompt string `json:"prompt"`
		Stream bool   `json:"stream"`
	}

	payload := OllamaRequest{
		Model:  "granite-code:3b",
		Prompt: prompt,
		Stream: false,
	}

	// TODO 2: Marshal the JSON and create an http.NewRequest("POST", ollamaURL, bytes.NewBuffer(jsonData))
	jsonData, err := json.Marshal(payload)
	if err != nil {
		return "", err
	}

	req, err := http.NewRequest("POST", ollamaURL, bytes.NewBuffer(jsonData))
	if err != nil {
		return "", err
	}

	// TODO 3: Add the Header!
	// req.Header.Add("Content-Type", "application/json")
	// (Notice we NO LONGER need the Authorization Bearer token header!)

	// TODO 4: Execute the request with c.HttpClient.Do(req)

	// TODO 5: Read the response body, unmarshal the JSON, and return the generated text!
	// Hint: The text will be located in responseJSON["response"]

	return "TODO: Return the AI's response", nil
}
