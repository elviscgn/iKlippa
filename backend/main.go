package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"net/url"
	"os"
	"strings"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/iklippa/backend/services"
)

func main() {
	router := gin.Default()
	watsonClient := services.NewWatsonxClient()
	httpClient := &http.Client{Timeout: 20 * time.Second}
	mlAPIURL := envOrDefault("ML_API_URL", "http://localhost:8000")

	api := router.Group("/api")
	{
		api.POST("/director/generate", func(c *gin.Context) {
			type RequestBody struct {
				Prompt string `json:"prompt"`
			}

			var requestBody RequestBody
			if err := c.ShouldBindJSON(&requestBody); err != nil {
				c.JSON(http.StatusBadRequest, gin.H{"error": "Invalid JSON!"})
				return
			}

			result, err := watsonClient.GenerateText(requestBody.Prompt)
			if err != nil {
				c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
				return

			}

			pythonPayload := map[string]string{
				"script_text": result,
			}

			payload, _ := json.Marshal(pythonPayload)

			response, err := httpClient.Post(
				mlAPIURL+"/analyze",
				"application/json",
				bytes.NewBuffer(payload),
			)
			if err != nil {
				c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
				return
			}
			defer response.Body.Close()

			responseMap := make(map[string]interface{})
			_ = json.NewDecoder(response.Body).Decode(&responseMap)

			// Send the final combined payload back to the React frontend!
			c.JSON(http.StatusOK, gin.H{
				"script":  result,
				"ml_data": responseMap,
			})
		})

		api.GET("/stock/videos", proxyStockSearch(httpClient, mlAPIURL, "/stock/videos"))
		api.GET("/stock/music", proxyStockSearch(httpClient, mlAPIURL, "/stock/music"))
		api.GET("/health", func(c *gin.Context) {
			c.JSON(http.StatusOK, gin.H{"ok": true})
		})
	}

	port := envOrDefault("PORT", "8081")
	fmt.Printf("Starting iKlippa Backend on http://localhost:%s\n", port)
	if err := router.Run(":" + port); err != nil {
		log.Fatalf("Server crashed: %v", err)
	}
}

func proxyStockSearch(
	client *http.Client,
	mlAPIURL string,
	path string,
) gin.HandlerFunc {
	return func(c *gin.Context) {
		query := strings.TrimSpace(c.Query("q"))
		if len(query) < 2 {
			c.JSON(http.StatusBadRequest, gin.H{"error": "Search needs at least 2 characters."})
			return
		}

		params := url.Values{"q": []string{query}}
		if path == "/stock/videos" {
			orientation := c.DefaultQuery("orientation", "landscape")
			params.Set("orientation", orientation)
		}

		response, err := client.Get(mlAPIURL + path + "?" + params.Encode())
		if err != nil {
			c.JSON(
				http.StatusBadGateway,
				gin.H{"error": "The stock media service is not running on port 8000."},
			)
			return
		}
		defer response.Body.Close()

		body, err := io.ReadAll(response.Body)
		if err != nil {
			c.JSON(http.StatusBadGateway, gin.H{"error": "Could not read the stock provider response."})
			return
		}

		contentType := response.Header.Get("Content-Type")
		if contentType == "" {
			contentType = "application/json"
		}
		c.Data(response.StatusCode, contentType, body)
	}
}

func envOrDefault(name string, fallback string) string {
	value := strings.TrimSpace(os.Getenv(name))
	if value == "" {
		return fallback
	}
	return strings.TrimRight(value, "/")
}
