package main

import (
	"strings"
	"testing"
)

func TestExtractJSONFromOutputUsesLastFencedBlock(t *testing.T) {
	out := "draft\n```json\n{\"summary\":\"old\"}\n```\nfinal\n```json\n{\"summary\":\"new\",\"count\":2}\n```"

	data, err := extractJSONFromOutput(out)
	if err != nil {
		t.Fatalf("extractJSONFromOutput returned error: %v", err)
	}

	if data["summary"] != "new" {
		t.Fatalf("summary = %v, want new", data["summary"])
	}
	if data["count"] != float64(2) {
		t.Fatalf("count = %#v, want 2", data["count"])
	}
}

func TestExtractJSONFromOutputParsesWholeObject(t *testing.T) {
	data, err := extractJSONFromOutput(`{"summary":"ok"}`)
	if err != nil {
		t.Fatalf("extractJSONFromOutput returned error: %v", err)
	}
	if data["summary"] != "ok" {
		t.Fatalf("summary = %v, want ok", data["summary"])
	}
}

func TestExtractJSONFromOutputRejectsMissingJSON(t *testing.T) {
	if _, err := extractJSONFromOutput("plain text"); err == nil {
		t.Fatalf("expected error for non-json output")
	}
}

func TestSchemaValidatorRequiredAndTypes(t *testing.T) {
	schema := map[string]interface{}{
		"required": []interface{}{"summary", "steps"},
		"properties": map[string]interface{}{
			"summary": map[string]interface{}{"type": "string"},
			"steps":   map[string]interface{}{"type": "array"},
			"ok":      map[string]interface{}{"type": "boolean"},
		},
	}

	errs := newSchemaValidator(schema).Validate(map[string]interface{}{
		"summary": 42.0,
		"ok":      true,
	})

	if len(errs) != 2 {
		t.Fatalf("expected 2 validation errors, got %d: %#v", len(errs), errs)
	}
}

func TestAppendOutputSchemaInstruction(t *testing.T) {
	task := appendOutputSchemaInstruction("do work", map[string]interface{}{
		"type": "object",
		"properties": map[string]interface{}{
			"status": map[string]interface{}{
				"type": "string",
				"enum": []interface{}{"passed", "failed", "blocked"},
			},
		},
	})

	if !strings.Contains(task, "<OUTPUT_SCHEMA>") || !strings.Contains(task, "```json") {
		t.Fatalf("schema instruction missing from task: %s", task)
	}
	if !strings.Contains(task, "$.status: \"passed\", \"failed\", \"blocked\"") {
		t.Fatalf("enum choices missing from task: %s", task)
	}
}

func TestAppendJSONOutputInstruction(t *testing.T) {
	task := appendJSONOutputInstruction("do work")

	if strings.Contains(task, "<OUTPUT_SCHEMA>") {
		t.Fatalf("schema should not be inlined for native output schema backends: %s", task)
	}
	if !strings.Contains(task, "<OUTPUT_FORMAT>") || !strings.Contains(task, "runtime output schema") {
		t.Fatalf("JSON output instruction missing from task: %s", task)
	}
}

func TestBackendSupportsNativeOutputSchema(t *testing.T) {
	if !backendSupportsNativeOutputSchema("codex") {
		t.Fatalf("codex should support native output schema")
	}
	if backendSupportsNativeOutputSchema("gemini") {
		t.Fatalf("gemini should not be marked as native output schema backend")
	}
}
