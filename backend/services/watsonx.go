package services

import (
	"bytes"
	"encoding/json"
	"fmt"
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

	jsonData, err := json.Marshal(payload)
	if err != nil {
		return "", err
	}

	req, err := http.NewRequest("POST", ollamaURL, bytes.NewBuffer(jsonData))
	if err != nil {
		return "", err
	}

	req.Header.Add("Content-Type", "application/json")

	resp, err := c.HttpClient.Do(req)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		return "", fmt.Errorf("ollama returned bad status: %s", resp.Status)
	}

	var responseJSON map[string]any

	if err := json.NewDecoder(resp.Body).Decode(&responseJSON); err != nil {
		return "", fmt.Errorf("failed to decode json response: %w", err)
	}

	generatedText, ok := responseJSON["response"].(string)
	if !ok {
		return "", fmt.Errorf("the 'response' key was missing or wasn't a valid string")
	}

	return generatedText, nil

}
