package main

import (
	"encoding/json"
	"fmt"
	"strings"
	"time"
)

func runMockTask(cfg *Config, outputSchema map[string]interface{}) TaskResult {
	scenario := mockScenario(cfg)
	result := TaskResult{
		ExitCode:  0,
		SessionID: "mock-session",
		Message:   fmt.Sprintf("Mock scenario %s completed.", scenario),
	}

	switch scenario {
	case "failure":
		result.ExitCode = 1
		result.Error = "Mock agent failed."
	case "timeout":
		time.Sleep(10 * time.Millisecond)
		result.ExitCode = 124
		result.Error = "Mock agent timed out."
	case "schema_failure":
		result.ExitCode = 2
		result.Error = "Mock agent produced an invalid schema payload."
		result.Message = `{"status":"invalid"}`
	case "success_with_change":
		result.Message = `{"status":"completed","summary":"Mock scenario success_with_change completed.","files_changed":["src/mock.ts"]}`
	case "success_no_change":
		result.Message = `{"status":"completed","summary":"Mock scenario success_no_change completed.","files_changed":[]}`
	default:
		result.Message = fmt.Sprintf(`{"status":"completed","summary":"Mock scenario %s completed.","files_changed":[]}`, scenario)
	}

	if len(outputSchema) > 0 && result.ExitCode == 0 {
		result.Message = ensureMockSchemaPayload(cfg, result.Message, scenario)
	}

	return result
}

func mockArtifacts(cfg *Config, result TaskResult, outputSchema map[string]interface{}) map[string]interface{} {
	if result.ExitCode != 0 {
		return nil
	}
	var artifacts map[string]interface{}
	if err := json.Unmarshal([]byte(result.Message), &artifacts); err == nil {
		return artifacts
	}
	if len(outputSchema) == 0 {
		return map[string]interface{}{
			"status":  "completed",
			"summary": strings.TrimSpace(result.Message),
		}
	}
	return nil
}

func mockScenario(cfg *Config) string {
	if cfg != nil {
		if cfg.Options != nil {
			if value, ok := cfg.Options["mock_scenario"].(string); ok && strings.TrimSpace(value) != "" {
				return strings.TrimSpace(value)
			}
			if value, ok := cfg.Options["scenario"].(string); ok && strings.TrimSpace(value) != "" {
				return strings.TrimSpace(value)
			}
		}
		if model := strings.TrimSpace(cfg.Model); strings.HasPrefix(model, "mock-") {
			return model
		}
	}
	return "success_no_change"
}

func ensureMockSchemaPayload(cfg *Config, message string, scenario string) string {
	var payload map[string]interface{}
	if err := json.Unmarshal([]byte(message), &payload); err == nil {
		if _, ok := payload["status"]; !ok {
			payload["status"] = "completed"
		}
		if _, ok := payload["summary"]; !ok {
			payload["summary"] = "Mock schema payload."
		}
		delete(payload, "files_changed")
		if _, ok := payload["changed_files"]; !ok {
			payload["changed_files"] = mockChangedFiles(cfg, scenario)
		}
		if _, ok := payload["verification"]; !ok {
			payload["verification"] = []interface{}{}
		}
		if _, ok := payload["criteria_mapping"]; !ok {
			payload["criteria_mapping"] = []interface{}{}
		}
		if _, ok := payload["evidence"]; !ok {
			payload["evidence"] = []interface{}{}
		}
		if _, ok := payload["issues"]; !ok {
			payload["issues"] = []interface{}{}
		}
		if _, ok := payload["risks"]; !ok {
			payload["risks"] = []interface{}{}
		}
		data, err := json.Marshal(payload)
		if err == nil {
			return string(data)
		}
	}
	return message
}

func mockChangedFiles(cfg *Config, scenario string) []interface{} {
	if scenario != "success_with_change" && scenario != "test_failure" {
		return []interface{}{}
	}
	return []interface{}{
		map[string]interface{}{
			"path":        firstAllowedPath(cfg),
			"change_type": "modified",
			"reason":      "Mock generator reports a deterministic fixture change.",
		},
	}
}

func firstAllowedPath(cfg *Config) string {
	if cfg != nil && cfg.Options != nil {
		if values, ok := cfg.Options["allowed_paths"].([]interface{}); ok {
			for _, value := range values {
				pathValue, ok := value.(string)
				if ok && pathValue != "" && !strings.Contains(pathValue, "*") {
					return pathValue
				}
			}
		}
	}
	return "src/index.ts"
}
