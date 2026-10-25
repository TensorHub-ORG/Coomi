use super::*;
use coomi_engine::{StepAction, WorkflowStep};
use std::time::Duration;
use tempfile::TempDir;

fn step(id: &str, action: StepAction) -> WorkflowStep {
    WorkflowStep::new(id, id, action)
}
fn write_step(id: &str, path: &str, text: &str) -> WorkflowStep {
    step(
        id,
        StepAction::Tool {
            tool: "write_file".into(),
            arguments: json!({"path":path,"content":text}),
        },
    )
}
fn setup(steps: Vec<WorkflowStep>) -> (TempDir, PathBuf, Arc<WorkflowScheduler>) {
    let temp = tempfile::tempdir().unwrap();
    let home = temp.path().join("data");
    let cwd = temp.path().join("workspace");
    std::fs::create_dir_all(&cwd).unwrap();
    std::fs::create_dir_all(&home).unwrap();
    let mut workflow = WorkflowState::new("test", "Test", steps);
    workflow.permission = "full".into();
    WorkflowStore::new(&home).save(&workflow).unwrap();
    let scheduler = WorkflowScheduler::with_workspace(&home, &cwd);
    (temp, cwd, scheduler)
}
pub(super) async fn wait_status(
    scheduler: &WorkflowScheduler,
    id: &str,
    statuses: &[&str],
) -> RunRecord {
    tokio::time::timeout(Duration::from_secs(20), async {
        loop {
            if let Some(record) = scheduler
                .runs
                .list("test")
                .unwrap()
                .into_iter()
                .find(|r| r.id == id)
            {
                if statuses.contains(&record.status.as_str()) {
                    return record;
                }
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    })
    .await
    .expect("workflow status timed out")
}
pub(super) fn setup_for_executor() -> (TempDir, PathBuf, Arc<WorkflowScheduler>) {
    setup(vec![step(
        "gate",
        StepAction::Approval {
            prompt: "Continue?".into(),
        },
    )])
}
async fn finished(scheduler: &WorkflowScheduler, id: &str) -> RunRecord {
    let record = wait_status(scheduler, id, &["completed", "failed", "cancelled"]).await;
    // The run releases its reservation after saving the final checkpoint.
    tokio::time::timeout(Duration::from_secs(3), async {
        while scheduler.ensure_inactive("test").is_err() {
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
    record
}

#[tokio::test]
async fn failures_stop_dependents_and_are_not_reported_as_cancellation() {
    let bad = step(
        "bad",
        StepAction::Script {
            command: "exit 7".into(),
            timeout_s: Some(10),
        },
    );
    let (_temp, cwd, scheduler) = setup(vec![
        bad,
        write_step("after", "should-not-exist", "bad").depends_on(&["bad"]),
    ]);
    let id = scheduler.run_manual("test").await.unwrap();
    let record = finished(&scheduler, &id).await;
    assert_eq!(record.status, "failed");
    assert_eq!(record.steps[0].state, "failed");
    assert!(record.steps[0].error.as_ref().unwrap().contains("exit"));
    assert!(!cwd.join("should-not-exist").exists());
    assert_eq!(record.steps[1].state, "pending");
}
#[tokio::test]
async fn fresh_runs_execute_again_in_the_workspace_without_overwriting_definition() {
    let (_temp, cwd, scheduler) = setup(vec![write_step("write", "result.txt", "first")]);
    let first = scheduler.run_manual("test").await.unwrap();
    assert_eq!(finished(&scheduler, &first).await.status, "completed");
    std::fs::write(cwd.join("result.txt"), "changed externally").unwrap();
    let second = scheduler.run_manual("test").await.unwrap();
    assert_eq!(finished(&scheduler, &second).await.status, "completed");
    assert_eq!(
        std::fs::read_to_string(cwd.join("result.txt")).unwrap(),
        "first"
    );
    let definition = scheduler.store.read("test").unwrap();
    assert_eq!(definition.steps[0].state, WorkflowStepState::Pending);
    assert!(definition.steps[0].result.is_none());
    assert!(!scheduler.home.join("result.txt").exists());
}
#[tokio::test]
async fn unknown_tool_fails_and_retains_its_error() {
    let (_temp, _, scheduler) = setup(vec![step(
        "bad",
        StepAction::Tool {
            tool: "missing_tool".into(),
            arguments: json!({}),
        },
    )]);
    let id = scheduler.run_manual("test").await.unwrap();
    let record = finished(&scheduler, &id).await;
    assert_eq!(record.status, "failed");
    assert!(
        record.steps[0]
            .error
            .as_ref()
            .unwrap()
            .contains("unavailable")
    );
}
#[tokio::test]
async fn approval_denial_stops_work_and_ask_mode_prevents_unapproved_file_writes() {
    let (_temp, cwd, scheduler) = setup(vec![write_step("write", "result.txt", "content")]);
    let mut workflow = scheduler.store.read("test").unwrap();
    workflow.permission = "ask".into();
    scheduler.store.save(&workflow).unwrap();
    let id = scheduler.run_manual("test").await.unwrap();
    let record = wait_status(&scheduler, &id, &["awaiting_approval"]).await;
    assert!(!cwd.join("result.txt").exists());
    scheduler
        .answer(
            "test",
            &id,
            &record.pending.unwrap().id,
            json!({"allow":false}),
        )
        .unwrap();
    assert_eq!(finished(&scheduler, &id).await.status, "failed");
    assert!(!cwd.join("result.txt").exists());
}
#[tokio::test]
async fn explicit_approval_and_pause_resume_keep_execution_at_a_safe_boundary() {
    let (_temp, cwd, scheduler) = setup(vec![
        step(
            "gate",
            StepAction::Approval {
                prompt: "Continue?".into(),
            },
        ),
        write_step("write", "result.txt", "ok").depends_on(&["gate"]),
    ]);
    let id = scheduler.run_manual("test").await.unwrap();
    let record = wait_status(&scheduler, &id, &["awaiting_approval"]).await;
    scheduler.action("test", &id, "pause").await.unwrap();
    scheduler
        .answer(
            "test",
            &id,
            &record.pending.unwrap().id,
            json!({"allow":true}),
        )
        .unwrap();
    wait_status(&scheduler, &id, &["paused"]).await;
    assert!(!cwd.join("result.txt").exists());
    scheduler.action("test", &id, "resume").await.unwrap();
    assert_eq!(finished(&scheduler, &id).await.status, "completed");
}
#[tokio::test]
async fn cancel_pending_approval_releases_run_and_does_not_execute_next_step() {
    let (_temp, cwd, scheduler) = setup(vec![
        step(
            "gate",
            StepAction::Approval {
                prompt: "Continue?".into(),
            },
        ),
        write_step("after", "result.txt", "no").depends_on(&["gate"]),
    ]);
    let id = scheduler.run_manual("test").await.unwrap();
    let record = wait_status(&scheduler, &id, &["awaiting_approval"]).await;
    scheduler.action("test", &id, "cancel").await.unwrap();
    assert_eq!(finished(&scheduler, &id).await.status, "cancelled");
    assert!(
        scheduler
            .answer(
                "test",
                &id,
                &record.pending.unwrap().id,
                json!({"allow":true})
            )
            .is_err()
    );
    assert!(!cwd.join("result.txt").exists());
}
#[tokio::test]
async fn recovery_skips_completed_steps_and_preserves_the_frozen_definition() {
    let (_temp, cwd, scheduler) = setup(vec![
        write_step("done", "keep.txt", "original"),
        step(
            "read",
            StepAction::Tool {
                tool: "read_file".into(),
                arguments: json!({"path":"input.txt"}),
            },
        )
        .depends_on(&["done"]),
    ]);
    let first = scheduler.run_manual("test").await.unwrap();
    assert_eq!(finished(&scheduler, &first).await.status, "failed");
    std::fs::write(cwd.join("keep.txt"), "external edit").unwrap();
    std::fs::write(cwd.join("input.txt"), "now available").unwrap();
    let mut definition = scheduler.store.read("test").unwrap();
    definition.name = "Edited while idle".into();
    scheduler.store.save(&definition).unwrap();
    let second = scheduler.recover("test", &first).await.unwrap();
    assert_eq!(finished(&scheduler, &second).await.status, "completed");
    assert_eq!(
        std::fs::read_to_string(cwd.join("keep.txt")).unwrap(),
        "external edit"
    );
    assert_eq!(
        scheduler.store.read("test").unwrap().name,
        "Edited while idle"
    );
}
#[tokio::test]
async fn nested_workflows_detect_cycles_and_propagate_failures() {
    let (_temp, _, scheduler) = setup(vec![step(
        "child",
        StepAction::SubWorkflow {
            workflow: "test".into(),
        },
    )]);
    assert!(
        scheduler
            .run_manual("test")
            .await
            .unwrap_err()
            .to_string()
            .contains("cycle")
    );
    assert!(scheduler.runs.list("test").unwrap().is_empty());
    let mut child = WorkflowState::new(
        "child",
        "Child",
        vec![step(
            "bad",
            StepAction::Tool {
                tool: "missing".into(),
                arguments: json!({}),
            },
        )],
    );
    child.permission = "full".into();
    scheduler.store.save(&child).unwrap();
    let mut parent = scheduler.store.read("test").unwrap();
    parent.steps[0].action = StepAction::SubWorkflow {
        workflow: "child".into(),
    };
    scheduler.store.save(&parent).unwrap();
    let id = scheduler.run_manual("test").await.unwrap();
    let record = finished(&scheduler, &id).await;
    assert_eq!(record.status, "failed");
    assert_eq!(
        record.children["/child"].steps[0].state,
        WorkflowStepState::Failed
    );
}
#[test]
fn cron_uses_the_supplied_minute_and_rejects_invalid_definition() {
    let minute = chrono::Local
        .with_ymd_and_hms(2026, 10, 25, 4, 15, 0)
        .unwrap()
        .timestamp() as u64
        / 60;
    assert!(cron_matches_minute("15 4 * * *", minute));
    assert!(!cron_matches_minute("15 4 * * *", minute + 1));
    assert!(!cron_matches_minute("not cron", minute));
    let mut workflow = WorkflowState::new("valid", "name", vec![write_step("one", "out", "hi")]);
    workflow.schedule.cron = Some("not cron".into());
    assert!(validate_definition(&workflow).is_err());
    workflow.schedule.cron = None;
    workflow.id = "../escape".into();
    assert!(workflow.validate().is_err());
}
#[test]
fn corrupted_history_is_not_overwritten_and_stale_runs_are_interrupted() {
    let (_temp, _, scheduler) = setup(vec![write_step("write", "out", "hi")]);
    let file = scheduler.runs.file("test").unwrap();
    std::fs::write(&file, "{corrupt").unwrap();
    assert!(scheduler.runs.recover_stale().is_err());
    assert_eq!(std::fs::read_to_string(file).unwrap(), "{corrupt");
}
#[tokio::test]
async fn restart_marks_active_checkpoint_interrupted_without_replaying_it() {
    let (_temp, cwd, scheduler) = setup(vec![
        step(
            "gate",
            StepAction::Approval {
                prompt: "Continue?".into(),
            },
        ),
        write_step("write", "out", "hi"),
    ]);
    let id = scheduler.run_manual("test").await.unwrap();
    wait_status(&scheduler, &id, &["awaiting_approval"]).await;
    // Capture exactly the on-disk state a new process would observe, then stop the original run.
    let bytes = std::fs::read(scheduler.runs.file("test").unwrap()).unwrap();
    scheduler.action("test", &id, "cancel").await.unwrap();
    std::fs::write(scheduler.runs.file("test").unwrap(), bytes).unwrap();
    scheduler.runs.recover_stale().unwrap();
    let record = &scheduler.runs.list("test").unwrap()[0];
    assert_eq!(record.status, "interrupted");
    assert!(record.pending.is_none());
    assert!(record.snapshot.is_some());
    assert!(!cwd.join("out").exists());
}
#[tokio::test]
async fn model_step_uses_configured_provider_and_records_response_and_usage() {
    use axum::{Json, Router, routing::post};
    let (_temp, _, scheduler) = setup(vec![step(
        "model",
        StepAction::Model {
            prompt: "Say hello".into(),
            model: None,
            isolate: Some(true),
        },
    )]);
    let server=Router::new().route("/v1/chat/completions",post(|Json(request):Json<Value>|async move{
        assert_eq!(request["model"],"test-model");
        if request["stream"]==true{
            axum::response::Response::builder().header("content-type","text/event-stream").body(axum::body::Body::from(
                "data: {\"choices\":[{\"delta\":{\"content\":\"hello\"}}]}\n\ndata: {\"choices\":[],\"usage\":{\"prompt_tokens\":10,\"completion_tokens\":2}}\n\ndata: [DONE]\n\n")).unwrap()
        }else{
            axum::response::Response::builder().header("content-type","application/json").body(axum::body::Body::from(
                json!({"choices":[{"message":{"role":"assistant","content":"hello"}}],"usage":{"prompt_tokens":10,"completion_tokens":2}}).to_string())).unwrap()
        }
    }));
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let handle = tokio::spawn(async move { axum::serve(listener, server).await.unwrap() });
    atomic_json(&scheduler.home.join("config/providers.json"),&json!({"active":"test","providers":{"test":{
        "type":"openai_compatible","api_key":"local-test","base_url":format!("http://{addr}/v1"),"model":"test-model"
    }}})).unwrap();
    let id = scheduler.run_manual("test").await.unwrap();
    let record = finished(&scheduler, &id).await;
    handle.abort();
    assert_eq!(record.status, "completed", "{:?}", record.steps);
    assert_eq!(record.steps[0].result.as_ref().unwrap()["output"], "hello");
    assert_eq!(record.usage.total_tokens(), 12);
    assert!(!record.sessions.is_empty());
}
fn delayed_command() -> String {
    #[cfg(windows)]
    {
        "Set-Content -LiteralPath started.txt -Value ready; Start-Sleep -Seconds 3; Set-Content -LiteralPath late.txt -Value unwanted".into()
    }
    #[cfg(not(windows))]
    {
        "printf ready > started.txt; sleep 3; printf unwanted > late.txt".into()
    }
}
#[tokio::test]
async fn cancelled_script_cannot_write_after_cancel_returns() {
    let (_temp, cwd, scheduler) = setup(vec![step(
        "script",
        StepAction::Script {
            command: delayed_command(),
            timeout_s: Some(15),
        },
    )]);
    let id = scheduler.run_manual("test").await.unwrap();
    tokio::time::timeout(Duration::from_secs(10), async {
        while !cwd.join("started.txt").exists() {
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    })
    .await
    .unwrap();
    scheduler.action("test", &id, "cancel").await.unwrap();
    assert_eq!(finished(&scheduler, &id).await.status, "cancelled");
    tokio::time::sleep(Duration::from_secs(4)).await;
    assert!(!cwd.join("late.txt").exists());
}
#[tokio::test]
async fn timed_out_script_is_failed_and_cleans_up() {
    let mut script = step(
        "script",
        StepAction::Script {
            command: delayed_command(),
            timeout_s: Some(1),
        },
    );
    script.timeout_s = Some(1);
    let (_temp, cwd, scheduler) = setup(vec![script]);
    let id = scheduler.run_manual("test").await.unwrap();
    let record = finished(&scheduler, &id).await;
    assert_eq!(record.status, "failed");
    assert!(
        record.steps[0]
            .error
            .as_ref()
            .unwrap()
            .contains("timed out")
    );
    tokio::time::sleep(Duration::from_secs(4)).await;
    assert!(!cwd.join("late.txt").exists());
}

#[tokio::test]
async fn local_shell_command_waits_for_exit_before_dependencies() {
    #[cfg(windows)]
    let command =
        "Start-Sleep -Milliseconds 350; Set-Content -LiteralPath input.txt -Value ready; exit 7";
    #[cfg(not(windows))]
    let command = "sleep 0.35; printf ready > input.txt; exit 7";
    let (_temp, cwd, scheduler) = setup(vec![
        step(
            "command",
            StepAction::Tool {
                tool: "local_shell".into(),
                arguments: json!({"command":command,"yield_time_ms":0}),
            },
        ),
        write_step("after", "after.txt", "bad").depends_on(&["command"]),
    ]);
    let id = scheduler.run_manual("test").await.unwrap();
    let record = finished(&scheduler, &id).await;
    assert_eq!(record.status, "failed");
    assert!(cwd.join("input.txt").exists());
    assert!(!cwd.join("after.txt").exists());
    assert!(record.steps[0].error.as_ref().unwrap().contains("exit"));
}

#[tokio::test]
async fn queued_resume_does_not_report_execution_or_resurrect_a_finished_run() {
    let (_temp, cwd, scheduler) = setup(vec![write_step("write", "out", "ready")]);
    let permits = scheduler.slots.clone().acquire_many_owned(2).await.unwrap();
    let id = scheduler.run_manual("test").await.unwrap();
    assert!(scheduler.action("test", &id, "resume").await.is_err());
    scheduler.action("test", &id, "pause").await.unwrap();
    scheduler.action("test", &id, "resume").await.unwrap();
    assert_eq!(scheduler.runs.list("test").unwrap()[0].status, "queued");
    assert!(!cwd.join("out").exists());
    let state = scheduler
        .active
        .lock()
        .unwrap()
        .get("test")
        .unwrap()
        .state
        .clone();
    drop(permits);
    assert_eq!(finished(&scheduler, &id).await.status, "completed");
    assert!(state.pause().is_err());
    assert!(state.resume().is_err());
    assert_eq!(scheduler.runs.list("test").unwrap()[0].status, "completed");
}

#[tokio::test]
async fn missing_model_fails_before_prior_file_side_effects() {
    let (_temp, cwd, scheduler) = setup(vec![
        write_step("first", "out", "bad"),
        step(
            "model",
            StepAction::Model {
                prompt: "hello".into(),
                model: None,
                isolate: None,
            },
        )
        .depends_on(&["first"]),
    ]);
    assert!(scheduler.run_manual("test").await.is_err());
    assert!(!cwd.join("out").exists());
    assert!(scheduler.runs.list("test").unwrap().is_empty());
}

#[tokio::test]
async fn model_cannot_continue_after_user_denies_its_tool() {
    use axum::{Router, routing::post};
    let (_temp, cwd, scheduler) = setup(vec![step(
        "model",
        StepAction::Model {
            prompt: "Write a file".into(),
            model: None,
            isolate: None,
        },
    )]);
    let mut workflow = scheduler.store.read("test").unwrap();
    workflow.permission = "ask".into();
    scheduler.store.save(&workflow).unwrap();
    let requests = Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let counter = requests.clone();
    let server = Router::new().route(
        "/v1/chat/completions",
        post(move || {
            let counter = counter.clone();
            async move {
                let n = counter.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                let delta = if n == 0 {
                    json!({"tool_calls":[{"index":0,"id":"write-call","type":"function","function":{
                "name":"write_file","arguments":"{\"path\":\"denied.txt\",\"content\":\"bad\"}"}}]})
                } else {
                    json!({"content":"This must not be reported as success"})
                };
                axum::response::Response::builder()
                    .header("content-type", "text/event-stream")
                    .body(axum::body::Body::from(format!(
                        "data: {}\n\ndata: [DONE]\n\n",
                        json!({"choices":[{"delta":delta}]})
                    )))
                    .unwrap()
            }
        }),
    );
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let handle = tokio::spawn(async move { axum::serve(listener, server).await.unwrap() });
    atomic_json(&scheduler.home.join("config/providers.json"),&json!({"active":"test","providers":{"test":{
        "type":"openai_compatible","api_key":"local-test","base_url":format!("http://{addr}/v1"),"model":"test-model"
    }}})).unwrap();
    let id = scheduler.run_manual("test").await.unwrap();
    let record = wait_status(&scheduler, &id, &["awaiting_approval"]).await;
    scheduler
        .answer(
            "test",
            &id,
            &record.pending.unwrap().id,
            json!({"allow":false}),
        )
        .unwrap();
    assert_eq!(finished(&scheduler, &id).await.status, "failed");
    assert_eq!(requests.load(std::sync::atomic::Ordering::SeqCst), 1);
    assert!(!cwd.join("denied.txt").exists());
    handle.abort();
}
