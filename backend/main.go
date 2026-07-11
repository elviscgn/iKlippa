package main

import (
	"fmt"
	"log"
	"net/http"

	"github.com/gin-gonic/gin"
	"github.com/iklippa/backend/services"
)

func main() {
	// Create a new Gin router
	// (Gin automatically includes crash recovery and logging out of the box!)
	router := gin.Default()

	// Initialize our shiny new local Ollama/Granite client
	watsonClient := services.NewWatsonxClient()

	// Create a route group for our API
	api := router.Group("/api")
	{
		// TODO 1: Create a POST route at "/director/generate"
		// Example: api.POST("/director/generate", func(c *gin.Context) { ... })

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

			c.JSON(http.StatusOK, gin.H{"response": result})
		})

	}

	// Start the server on port 8080
	fmt.Println("🎬 Starting iKlippa Backend on http://localhost:8080")
	if err := router.Run(":8080"); err != nil {
		log.Fatalf("Server crashed: %v", err)
	}
}
