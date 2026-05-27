package main

import (
	"encoding/json"
	"io"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestRunJSONOutputWithSchema(t *testing.T) {
	oldArgs := os.Args
	oldRunTaskFn := runTaskFn
	oldExitFn := exitFn
	oldStdout := os.Stdout
	defer func() {
		os.Args = oldArgs
		runTaskFn = oldRunTaskFn
		exitFn = oldExitFn
		os.Stdout = oldStdout
		resetTestHooks()
	}()

	dir := t.TempDir()
	schemaPath := filepath.Join(dir, "schema.json")
	if err := os.WriteFile(schemaPath, []byte(`{
		"type": "object",
		"required": ["summary"],
		"properties": {"summary": {"type": "string"}}
	}`), 0o600); err != nil {
		t.Fatal(err)
	}

	runTaskFn = func(task TaskSpec, silent bool, timeout int) TaskResult {
		if !strings.Contains(task.Task, "<OUTPUT_FORMAT>") {
			t.Fatalf("task does not include JSON output instruction: %s", task.Task)
		}
		if strings.Contains(task.Task, "\"properties\"") {
			t.Fatalf("native Codex schema path should not inline schema into task: %s", task.Task)
		}
		return TaskResult{
			ExitCode:  0,
			Message:   "done\n```json\n{\"summary\":\"ok\"}\n```",
			SessionID: "sess-1",
			LogPath:   filepath.Join(dir, "run.log"),
		}
	}

	readPipe, writePipe, err := os.Pipe()
	if err != nil {
		t.Fatal(err)
	}
	os.Stdout = writePipe
	os.Args = []string{"codeagent-wrapper", "--json-output", "--output-schema", schemaPath, "task", dir}
	exitFn = func(int) {}

	code := run()
	_ = writePipe.Close()
	output := readAllString(t, readPipe)

	if code != 0 {
		t.Fatalf("run exit code = %d, output=%s", code, output)
	}

	var result StepResult
	if err := json.Unmarshal([]byte(strings.TrimSpace(output)), &result); err != nil {
		t.Fatalf("invalid json output %q: %v", output, err)
	}
	if !result.Success || result.SessionID != "sess-1" {
		t.Fatalf("unexpected result: %#v", result)
	}
	if result.Artifacts["summary"] != "ok" {
		t.Fatalf("artifacts = %#v", result.Artifacts)
	}
}

func readAllString(t *testing.T, file *os.File) string {
	t.Helper()
	data, err := io.ReadAll(file)
	if err != nil {
		t.Fatal(err)
	}
	return string(data)
}
