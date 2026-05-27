package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"os"
	"regexp"
	"sort"
	"strings"
)

type ValidationError struct {
	Field   string `json:"field"`
	Message string `json:"message"`
}

type SchemaValidator struct {
	Required []string
	Fields   map[string]string
}

func loadOutputSchema(path string) (map[string]interface{}, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	var schema map[string]interface{}
	if err := json.Unmarshal(data, &schema); err != nil {
		return nil, err
	}
	return schema, nil
}

func appendOutputSchemaInstruction(task string, schema map[string]interface{}) string {
	if len(schema) == 0 {
		return task
	}
	data, err := json.MarshalIndent(schema, "", "  ")
	if err != nil {
		return task
	}

	var b strings.Builder
	b.WriteString(strings.TrimRight(task, "\n"))
	b.WriteString("\n\n<OUTPUT_SCHEMA>\n")
	b.WriteString("You MUST respond with exactly one JSON object wrapped in a ```json code block.\n")
	b.WriteString("Do not include prose outside the JSON block.\n")
	b.WriteString("The JSON must conform to the schema loaded from the --output-schema file:\n")
	b.WriteString(string(data))

	if choices := collectSchemaEnumChoices("$", schema); len(choices) > 0 {
		b.WriteString("\n\nAllowed enum values:\n")
		for _, choice := range choices {
			b.WriteString("- ")
			b.WriteString(choice.Path)
			b.WriteString(": ")
			b.WriteString(strings.Join(choice.Values, ", "))
			b.WriteByte('\n')
		}
	}

	b.WriteString("\n</OUTPUT_SCHEMA>\n")
	return b.String()
}

func appendJSONOutputInstruction(task string) string {
	return strings.TrimRight(task, "\n") + "\n\n<OUTPUT_FORMAT>\n" +
		"Respond with exactly one JSON object that conforms to the runtime output schema.\n" +
		"Do not include prose outside the JSON object.\n" +
		"</OUTPUT_FORMAT>\n"
}

func backendSupportsNativeOutputSchema(backend string) bool {
	return strings.EqualFold(strings.TrimSpace(backend), "codex")
}

type SchemaEnumChoice struct {
	Path   string
	Values []string
}

func collectSchemaEnumChoices(path string, schema map[string]interface{}) []SchemaEnumChoice {
	var choices []SchemaEnumChoice
	if len(schema) == 0 {
		return choices
	}

	if enumValues, ok := schema["enum"].([]interface{}); ok && len(enumValues) > 0 {
		values := make([]string, 0, len(enumValues))
		for _, value := range enumValues {
			values = append(values, formatJSONValue(value))
		}
		choices = append(choices, SchemaEnumChoice{Path: path, Values: values})
	}

	if properties, ok := schema["properties"].(map[string]interface{}); ok {
		keys := make([]string, 0, len(properties))
		for key := range properties {
			keys = append(keys, key)
		}
		sort.Strings(keys)
		for _, key := range keys {
			if child, ok := properties[key].(map[string]interface{}); ok {
				choices = append(choices, collectSchemaEnumChoices(path+"."+key, child)...)
			}
		}
	}

	if items, ok := schema["items"].(map[string]interface{}); ok {
		choices = append(choices, collectSchemaEnumChoices(path+"[]", items)...)
	}

	for _, key := range []string{"allOf", "anyOf", "oneOf"} {
		rawChildren, ok := schema[key].([]interface{})
		if !ok {
			continue
		}
		for index, rawChild := range rawChildren {
			if child, ok := rawChild.(map[string]interface{}); ok {
				choices = append(choices, collectSchemaEnumChoices(fmt.Sprintf("%s.%s[%d]", path, key, index), child)...)
			}
		}
	}

	return choices
}

func formatJSONValue(value interface{}) string {
	data, err := json.Marshal(value)
	if err != nil {
		return fmt.Sprintf("%v", value)
	}
	return string(data)
}

var fencedJSONBlockRe = regexp.MustCompile("(?is)```json\\s*(.*?)\\s*```")

func extractJSONFromOutput(output string) (map[string]interface{}, error) {
	output = strings.TrimSpace(output)
	if output == "" {
		return nil, fmt.Errorf("output is empty")
	}

	matches := fencedJSONBlockRe.FindAllStringSubmatch(output, -1)
	if len(matches) > 0 {
		for i := len(matches) - 1; i >= 0; i-- {
			if data, err := parseJSONObject(matches[i][1]); err == nil {
				return data, nil
			}
		}
		return nil, fmt.Errorf("no valid JSON object found in fenced json blocks")
	}

	return parseJSONObject(output)
}

func parseJSONObject(raw string) (map[string]interface{}, error) {
	decoder := json.NewDecoder(bytes.NewBufferString(strings.TrimSpace(raw)))
	decoder.UseNumber()

	var data map[string]interface{}
	if err := decoder.Decode(&data); err != nil {
		return nil, err
	}
	return normalizeJSONNumbers(data), nil
}

func normalizeJSONNumbers(data map[string]interface{}) map[string]interface{} {
	out := make(map[string]interface{}, len(data))
	for k, v := range data {
		out[k] = normalizeJSONValue(v)
	}
	return out
}

func normalizeJSONValue(v interface{}) interface{} {
	switch val := v.(type) {
	case json.Number:
		if i, err := val.Int64(); err == nil {
			return float64(i)
		}
		if f, err := val.Float64(); err == nil {
			return f
		}
		return val.String()
	case map[string]interface{}:
		return normalizeJSONNumbers(val)
	case []interface{}:
		for i := range val {
			val[i] = normalizeJSONValue(val[i])
		}
		return val
	default:
		return v
	}
}

func newSchemaValidator(schema map[string]interface{}) SchemaValidator {
	validator := SchemaValidator{Fields: make(map[string]string)}
	if len(schema) == 0 {
		return validator
	}

	if required, ok := schema["required"].([]interface{}); ok {
		for _, item := range required {
			if s, ok := item.(string); ok && s != "" {
				validator.Required = append(validator.Required, s)
			}
		}
	}

	if properties, ok := schema["properties"].(map[string]interface{}); ok {
		for name, raw := range properties {
			prop, ok := raw.(map[string]interface{})
			if !ok {
				continue
			}
			if typ, ok := prop["type"].(string); ok && typ != "" {
				validator.Fields[name] = typ
			}
		}
	}

	return validator
}

func (v SchemaValidator) Validate(data map[string]interface{}) []ValidationError {
	var errors []ValidationError

	for _, field := range v.Required {
		if _, ok := data[field]; !ok {
			errors = append(errors, ValidationError{Field: field, Message: "required field is missing"})
		}
	}

	for field, expected := range v.Fields {
		value, ok := data[field]
		if !ok {
			continue
		}
		if !matchesJSONType(value, expected) {
			errors = append(errors, ValidationError{
				Field:   field,
				Message: fmt.Sprintf("expected %s, got %T", expected, value),
			})
		}
	}

	return errors
}

func matchesJSONType(value interface{}, expected string) bool {
	switch expected {
	case "string":
		_, ok := value.(string)
		return ok
	case "number", "integer":
		_, ok := value.(float64)
		return ok
	case "boolean":
		_, ok := value.(bool)
		return ok
	case "array":
		_, ok := value.([]interface{})
		return ok
	case "object":
		_, ok := value.(map[string]interface{})
		return ok
	default:
		return true
	}
}

func buildStepResult(result TaskResult, artifacts map[string]interface{}, durationMs int64) StepResult {
	return StepResult{
		Success:    result.ExitCode == 0 && result.Error == "",
		SessionID:  result.SessionID,
		Message:    result.Message,
		Artifacts:  artifacts,
		ExitCode:   result.ExitCode,
		Error:      result.Error,
		LogPath:    result.LogPath,
		DurationMs: durationMs,
	}
}
