package main

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"strconv"
	"strings"
)

// Config holds CLI configuration
type Config struct {
	Mode               string // "new" or "resume"
	Task               string
	SessionID          string
	WorkDir            string
	ExplicitStdin      bool
	Timeout            int
	Agent              string
	Backend            string // internal alias for existing backend execution code
	SkipPermissions    bool
	MaxParallelWorkers int
	Model              string // Generic agent model name (empty = use backend default)
	CodexModel         string // Deprecated CLI compatibility; use Model.
	ClaudeModel        string // Deprecated CLI compatibility; use Model.
	GeminiModel        string // Deprecated CLI compatibility; use Model.
	Progress           bool   // Emit compact progress lines to stderr
	JSONOutput         bool   // Emit structured StepResult JSON
	OutputSchemaPath   string // Optional JSON schema file for structured artifact extraction
	Env                map[string]string
	Options            map[string]interface{}
}

// ParallelConfig defines the JSON schema for parallel execution
type ParallelConfig struct {
	Tasks         []TaskSpec `json:"tasks"`
	GlobalBackend string     `json:"backend,omitempty"`
}

// TaskSpec describes an individual task entry in the parallel config
type TaskSpec struct {
	ID           string            `json:"id"`
	Task         string            `json:"task"`
	WorkDir      string            `json:"workdir,omitempty"`
	Dependencies []string          `json:"dependencies,omitempty"`
	SessionID    string            `json:"session_id,omitempty"`
	Backend      string            `json:"backend,omitempty"`
	Progress     bool              `json:"-"`
	Mode         string            `json:"-"`
	UseStdin     bool              `json:"-"`
	Context      context.Context   `json:"-"`
	Env          map[string]string `json:"-"`
}

// TaskResult captures the execution outcome of a task
type TaskResult struct {
	TaskID    string `json:"task_id"`
	ExitCode  int    `json:"exit_code"`
	Message   string `json:"message"`
	SessionID string `json:"session_id"`
	Error     string `json:"error"`
	LogPath   string `json:"log_path"`
	// Structured report fields
	Coverage       string   `json:"coverage,omitempty"`        // extracted coverage percentage (e.g., "92%")
	CoverageNum    float64  `json:"coverage_num,omitempty"`    // numeric coverage for comparison
	CoverageTarget float64  `json:"coverage_target,omitempty"` // target coverage (default 90)
	FilesChanged   []string `json:"files_changed,omitempty"`   // list of changed files
	KeyOutput      string   `json:"key_output,omitempty"`      // brief summary of what was done
	TestsPassed    int      `json:"tests_passed,omitempty"`    // number of tests passed
	TestsFailed    int      `json:"tests_failed,omitempty"`    // number of tests failed
	sharedLog      bool
}

// StepResult is the structured single-step result emitted by --json-output.
type StepResult struct {
	Success    bool                   `json:"success"`
	Agent      string                 `json:"agent,omitempty"`
	Model      string                 `json:"model,omitempty"`
	SessionID  string                 `json:"session_id,omitempty"`
	Message    string                 `json:"message"`
	Artifacts  map[string]interface{} `json:"artifacts,omitempty"`
	ExitCode   int                    `json:"exit_code"`
	Error      string                 `json:"error,omitempty"`
	LogPath    string                 `json:"log_path,omitempty"`
	DurationMs int64                  `json:"duration_ms"`
}

// JSONRunRequest is the stable machine-facing wrapper request protocol.
type JSONRunRequest struct {
	Agent            string                 `json:"agent"`
	Model            string                 `json:"model,omitempty"`
	Prompt           string                 `json:"prompt"`
	CWD              string                 `json:"cwd"`
	Mode             string                 `json:"mode,omitempty"`
	SessionID        string                 `json:"session_id,omitempty"`
	TimeoutMS        int                    `json:"timeout_ms,omitempty"`
	JSONOutput       bool                   `json:"json_output,omitempty"`
	OutputSchemaPath string                 `json:"output_schema_path,omitempty"`
	Env              map[string]string      `json:"env,omitempty"`
	Options          map[string]interface{} `json:"options,omitempty"`
}

var backendRegistry = map[string]Backend{
	"mock":   MockBackend{},
	"codex":  CodexBackend{},
	"claude": ClaudeBackend{},
	"gemini": GeminiBackend{},
}

func selectBackend(name string) (Backend, error) {
	key := strings.ToLower(strings.TrimSpace(name))
	if key == "" {
		key = defaultBackendName
	}
	if backend, ok := backendRegistry[key]; ok {
		return backend, nil
	}
	return nil, fmt.Errorf("unsupported backend %q", name)
}

func envFlagEnabled(key string) bool {
	val, ok := os.LookupEnv(key)
	if !ok {
		return false
	}
	val = strings.TrimSpace(strings.ToLower(val))
	switch val {
	case "", "0", "false", "no", "off":
		return false
	default:
		return true
	}
}

func parseBoolFlag(val string, defaultValue bool) bool {
	val = strings.TrimSpace(strings.ToLower(val))
	switch val {
	case "1", "true", "yes", "on":
		return true
	case "0", "false", "no", "off":
		return false
	default:
		return defaultValue
	}
}

func parseParallelConfig(data []byte) (*ParallelConfig, error) {
	trimmed := bytes.TrimSpace(data)
	if len(trimmed) == 0 {
		return nil, fmt.Errorf("parallel config is empty")
	}

	tasks := strings.Split(string(trimmed), "---TASK---")
	var cfg ParallelConfig
	seen := make(map[string]struct{})

	taskIndex := 0
	for _, taskBlock := range tasks {
		taskBlock = strings.TrimSpace(taskBlock)
		if taskBlock == "" {
			continue
		}
		taskIndex++

		parts := strings.SplitN(taskBlock, "---CONTENT---", 2)
		if len(parts) != 2 {
			return nil, fmt.Errorf("task block #%d missing ---CONTENT--- separator", taskIndex)
		}

		meta := strings.TrimSpace(parts[0])
		content := strings.TrimSpace(parts[1])

		task := TaskSpec{WorkDir: defaultWorkdir}
		for _, line := range strings.Split(meta, "\n") {
			line = strings.TrimSpace(line)
			if line == "" {
				continue
			}
			kv := strings.SplitN(line, ":", 2)
			if len(kv) != 2 {
				continue
			}
			key := strings.TrimSpace(kv[0])
			value := strings.TrimSpace(kv[1])

			switch key {
			case "id":
				task.ID = value
			case "workdir":
				task.WorkDir = value
			case "session_id":
				task.SessionID = value
				task.Mode = "resume"
			case "backend":
				task.Backend = value
			case "dependencies":
				for _, dep := range strings.Split(value, ",") {
					dep = strings.TrimSpace(dep)
					if dep != "" {
						task.Dependencies = append(task.Dependencies, dep)
					}
				}
			}
		}

		if task.Mode == "" {
			task.Mode = "new"
		}

		if task.ID == "" {
			return nil, fmt.Errorf("task block #%d missing id field", taskIndex)
		}
		if content == "" {
			return nil, fmt.Errorf("task block #%d (%q) missing content", taskIndex, task.ID)
		}
		if task.Mode == "resume" && strings.TrimSpace(task.SessionID) == "" {
			return nil, fmt.Errorf("task block #%d (%q) has empty session_id", taskIndex, task.ID)
		}
		if _, exists := seen[task.ID]; exists {
			return nil, fmt.Errorf("task block #%d has duplicate id: %s", taskIndex, task.ID)
		}

		task.Task = content
		cfg.Tasks = append(cfg.Tasks, task)
		seen[task.ID] = struct{}{}
	}

	if len(cfg.Tasks) == 0 {
		return nil, fmt.Errorf("no tasks found")
	}

	return &cfg, nil
}

func parseJSONRunRequest(data []byte) (*Config, error) {
	trimmed := bytes.TrimSpace(data)
	if len(trimmed) == 0 {
		return nil, fmt.Errorf("json request is empty")
	}

	var req JSONRunRequest
	if err := json.Unmarshal(trimmed, &req); err != nil {
		return nil, fmt.Errorf("invalid json request: %w", err)
	}

	agent := strings.ToLower(strings.TrimSpace(req.Agent))
	if agent == "" {
		return nil, fmt.Errorf("json request requires non-empty agent")
	}
	if _, err := selectBackend(agent); err != nil {
		return nil, err
	}

	prompt := req.Prompt
	if strings.TrimSpace(prompt) == "" {
		return nil, fmt.Errorf("json request requires non-empty prompt")
	}

	cwd := strings.TrimSpace(req.CWD)
	if cwd == "" {
		return nil, fmt.Errorf("json request requires non-empty cwd")
	}

	mode := strings.TrimSpace(req.Mode)
	if mode == "" {
		mode = "new"
	}
	if mode != "new" && mode != "resume" {
		return nil, fmt.Errorf("json request mode must be new or resume")
	}

	sessionID := strings.TrimSpace(req.SessionID)
	if mode == "resume" && sessionID == "" {
		return nil, fmt.Errorf("json request resume mode requires non-empty session_id")
	}

	timeoutSec := resolveTimeout()
	if req.TimeoutMS > 0 {
		timeoutSec = max(1, (req.TimeoutMS+999)/1000)
	}

	return &Config{
		Mode:             mode,
		Task:             prompt,
		SessionID:        sessionID,
		WorkDir:          cwd,
		ExplicitStdin:    false,
		Timeout:          timeoutSec,
		Agent:            agent,
		Backend:          agent,
		Model:            strings.TrimSpace(req.Model),
		SkipPermissions:  optionBool(req.Options, "skip_permissions"),
		Progress:         false,
		JSONOutput:       req.JSONOutput,
		OutputSchemaPath: strings.TrimSpace(req.OutputSchemaPath),
		Env:              req.Env,
		Options:          req.Options,
	}, nil
}

func optionBool(options map[string]interface{}, key string) bool {
	if options == nil {
		return false
	}
	value, ok := options[key]
	if !ok {
		return false
	}
	switch typed := value.(type) {
	case bool:
		return typed
	case string:
		return parseBoolFlag(typed, false)
	default:
		return false
	}
}

func parseRunConfig() (*Config, error) {
	if len(os.Args) > 1 {
		return parseArgs()
	}
	if isTerminal() {
		return parseArgs()
	}
	data, err := io.ReadAll(stdinReader)
	if err != nil {
		return nil, fmt.Errorf("read json request: %w", err)
	}
	return parseJSONRunRequest(data)
}

func parseArgs() (*Config, error) {
	args := os.Args[1:]
	if len(args) == 0 {
		return nil, fmt.Errorf("task required")
	}

	// Read environment variables (lowest precedence)
	codexModel := strings.TrimSpace(os.Getenv("CODEX_MODEL"))
	claudeModel := strings.TrimSpace(os.Getenv("CLAUDE_MODEL"))
	geminiModel := strings.TrimSpace(os.Getenv("GEMINI_MODEL"))

	backendName := defaultBackendName
	model := ""
	skipPermissions := envFlagEnabled("CODEAGENT_SKIP_PERMISSIONS")
	progress := false
	jsonOutput := false
	outputSchemaPath := ""
	filtered := make([]string, 0, len(args))
	for i := 0; i < len(args); i++ {
		arg := args[i]
		switch {
		case arg == "--lite", arg == "-L":
			liteMode = true
			continue
		case arg == "--web-ui":
			webUIMode = true
			continue
		case arg == "--backend":
			if i+1 >= len(args) {
				return nil, fmt.Errorf("--backend flag requires a value")
			}
			backendName = args[i+1]
			i++
			continue
		case strings.HasPrefix(arg, "--backend="):
			value := strings.TrimPrefix(arg, "--backend=")
			if value == "" {
				return nil, fmt.Errorf("--backend flag requires a value")
			}
			backendName = value
			continue
		case arg == "--model":
			if i+1 >= len(args) {
				return nil, fmt.Errorf("--model flag requires a non-empty model name")
			}
			value := strings.TrimSpace(args[i+1])
			if value == "" {
				return nil, fmt.Errorf("--model flag requires a non-empty model name")
			}
			model = value
			i++
			continue
		case strings.HasPrefix(arg, "--model="):
			value := strings.TrimSpace(strings.TrimPrefix(arg, "--model="))
			if value == "" {
				return nil, fmt.Errorf("--model flag requires a non-empty model name")
			}
			model = value
			continue
		case arg == "--codex-model":
			if i+1 >= len(args) {
				return nil, fmt.Errorf("--codex-model flag requires a non-empty model name")
			}
			value := strings.TrimSpace(args[i+1])
			if value == "" {
				return nil, fmt.Errorf("--codex-model flag requires a non-empty model name")
			}
			codexModel = value
			i++
			continue
		case strings.HasPrefix(arg, "--codex-model="):
			value := strings.TrimSpace(strings.TrimPrefix(arg, "--codex-model="))
			if value == "" {
				return nil, fmt.Errorf("--codex-model flag requires a non-empty model name")
			}
			codexModel = value
			continue
		case arg == "--claude-model":
			if i+1 >= len(args) {
				return nil, fmt.Errorf("--claude-model flag requires a non-empty model name")
			}
			value := strings.TrimSpace(args[i+1])
			if value == "" {
				return nil, fmt.Errorf("--claude-model flag requires a non-empty model name")
			}
			claudeModel = value
			i++
			continue
		case strings.HasPrefix(arg, "--claude-model="):
			value := strings.TrimSpace(strings.TrimPrefix(arg, "--claude-model="))
			if value == "" {
				return nil, fmt.Errorf("--claude-model flag requires a non-empty model name")
			}
			claudeModel = value
			continue
		case arg == "--gemini-model":
			if i+1 >= len(args) {
				return nil, fmt.Errorf("--gemini-model flag requires a non-empty model name")
			}
			value := strings.TrimSpace(args[i+1])
			if value == "" {
				return nil, fmt.Errorf("--gemini-model flag requires a non-empty model name")
			}
			geminiModel = value
			i++
			continue
		case strings.HasPrefix(arg, "--gemini-model="):
			value := strings.TrimSpace(strings.TrimPrefix(arg, "--gemini-model="))
			if value == "" {
				return nil, fmt.Errorf("--gemini-model flag requires a non-empty model name")
			}
			geminiModel = value
			continue
		case arg == "--skip-permissions", arg == "--dangerously-skip-permissions":
			skipPermissions = true
			continue
		case arg == "--progress":
			progress = true
			continue
		case arg == "--json-output":
			jsonOutput = true
			continue
		case arg == "--output-schema":
			if i+1 >= len(args) {
				return nil, fmt.Errorf("--output-schema flag requires a value")
			}
			outputSchemaPath = strings.TrimSpace(args[i+1])
			if outputSchemaPath == "" {
				return nil, fmt.Errorf("--output-schema flag requires a non-empty path")
			}
			i++
			continue
		case strings.HasPrefix(arg, "--output-schema="):
			value := strings.TrimSpace(strings.TrimPrefix(arg, "--output-schema="))
			if value == "" {
				return nil, fmt.Errorf("--output-schema flag requires a non-empty path")
			}
			outputSchemaPath = value
			continue
		case strings.HasPrefix(arg, "--skip-permissions="):
			skipPermissions = parseBoolFlag(strings.TrimPrefix(arg, "--skip-permissions="), skipPermissions)
			continue
		case strings.HasPrefix(arg, "--dangerously-skip-permissions="):
			skipPermissions = parseBoolFlag(strings.TrimPrefix(arg, "--dangerously-skip-permissions="), skipPermissions)
			continue
		}
		filtered = append(filtered, arg)
	}

	if len(filtered) == 0 {
		return nil, fmt.Errorf("task required")
	}
	args = filtered

	if model != "" {
		if strings.EqualFold(backendName, "gemini") {
			geminiModel = model
		} else if strings.EqualFold(backendName, "claude") {
			claudeModel = model
		} else {
			codexModel = model
		}
	}

	cfg := &Config{
		WorkDir:          defaultWorkdir,
		Backend:          backendName,
		SkipPermissions:  skipPermissions,
		Model:            modelForBackend(backendName, model, codexModel, claudeModel, geminiModel),
		CodexModel:       codexModel,
		ClaudeModel:      claudeModel,
		GeminiModel:      geminiModel,
		Progress:         progress,
		JSONOutput:       jsonOutput,
		OutputSchemaPath: outputSchemaPath,
	}
	cfg.MaxParallelWorkers = resolveMaxParallelWorkers()

	if args[0] == "resume" {
		if len(args) < 3 {
			return nil, fmt.Errorf("resume mode requires: resume <session_id> <task>")
		}
		cfg.Mode = "resume"
		cfg.SessionID = strings.TrimSpace(args[1])
		if cfg.SessionID == "" {
			return nil, fmt.Errorf("resume mode requires non-empty session_id")
		}
		cfg.Task = args[2]
		cfg.ExplicitStdin = (args[2] == "-")
		if len(args) > 3 {
			cfg.WorkDir = args[3]
		}
	} else {
		cfg.Mode = "new"
		cfg.Task = args[0]
		cfg.ExplicitStdin = (args[0] == "-")
		if len(args) > 1 {
			cfg.WorkDir = args[1]
		}
	}

	return cfg, nil
}

func modelForBackend(backendName, genericModel, codexModel, claudeModel, geminiModel string) string {
	if strings.TrimSpace(genericModel) != "" {
		return strings.TrimSpace(genericModel)
	}
	switch strings.ToLower(strings.TrimSpace(backendName)) {
	case "gemini":
		return strings.TrimSpace(geminiModel)
	case "claude":
		return strings.TrimSpace(claudeModel)
	default:
		return strings.TrimSpace(codexModel)
	}
}

const maxParallelWorkersLimit = 100

func resolveMaxParallelWorkers() int {
	raw := strings.TrimSpace(os.Getenv("CODEAGENT_MAX_PARALLEL_WORKERS"))
	if raw == "" {
		return 0
	}

	value, err := strconv.Atoi(raw)
	if err != nil || value < 0 {
		logWarn(fmt.Sprintf("Invalid CODEAGENT_MAX_PARALLEL_WORKERS=%q, falling back to unlimited", raw))
		return 0
	}

	if value > maxParallelWorkersLimit {
		logWarn(fmt.Sprintf("CODEAGENT_MAX_PARALLEL_WORKERS=%d exceeds limit, capping at %d", value, maxParallelWorkersLimit))
		return maxParallelWorkersLimit
	}

	return value
}
