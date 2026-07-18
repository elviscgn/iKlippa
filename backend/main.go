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
		// TODO 1: Create a POST route at "/director/generate"

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

			// TODO 3: Make an http.Post() request to "http://localhost:8000/analyze".
			// Pass "application/json" as the content-type, and bytes.NewBuffer(yourJsonBytes) as the body.
			// Don't forget to check for an error, and defer closing the response body!

			// TODO 4: Create a variable of type map[string]interface{} (this is how Go handles dynamic JSON).
			// Use json.NewDecoder(resp.Body).Decode(&yourMap) to unpack Python's response.

			// TODO 5: Send the final combined payload back to the React frontend!
			// Use c.JSON(http.StatusOK, gin.H{
			//     "script": result,
			//     "ml_data": yourMap,
			// })
		})

	}

	// Start the server on port 8080
	fmt.Println(" Starting iKlippa Backend on http://localhost:8080")
	if err := router.Run(":8080"); err != nil {
		log.Fatalf("Server crashed: %v", err)
	}
}
