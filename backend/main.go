package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"log"
	"net/http"

	"github.com/gin-gonic/gin"
	"github.com/iklippa/backend/services"
)

func main() {

	router := gin.Default()

	watsonClient := services.NewWatsonxClient()

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
				"script_text": string(result),
			}

			payload, _ := json.Marshal(pythonPayload)

			response, err := http.Post("http://localhost:8000/analyze", "application/json", bytes.NewBuffer(payload))
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

	}

	// Start the server on port 8080
	fmt.Println(" Starting iKlippa Backend on http://localhost:8080")
	if err := router.Run(":8080"); err != nil {
		log.Fatalf("Server crashed: %v", err)
	}
}
