use super::*;

fn setup() -> (tempfile::TempDir, AppState) {
    let temp = tempfile::tempdir().unwrap();
    let home = temp.path().join("home");
    let cwd = temp.path().join("workspace");
    std::fs::create_dir_all(&home).unwrap();
    std::fs::create_dir_all(&cwd).unwrap();
    let state = AppState {
        task_manager: Arc::new(TaskManager::open(&home).unwrap()),
        workflow_scheduler: crate::workflow::WorkflowScheduler::with_workspace(&home, &cwd),
        home,
        cwd,
        port: 0,
        token: "test".into(),
        permission: Arc::new(RwLock::new(PermissionMode::Auto)),
        tasks: Arc::new(StdMutex::new(HashMap::new())),
        task_slots: Arc::new(Semaphore::new(2)),
        vision_degraded: Arc::new(StdMutex::new(HashSet::new())),
        registry_cache: Arc::new(StdMutex::new(None)),
        studio_approvals: Arc::new(StdMutex::new(HashMap::new())),
        studio_runs: Arc::new(StdMutex::new(HashMap::new())),
        studio_events: Arc::new(StdMutex::new(HashMap::new())),
        group_chat_runs: Arc::new(StdMutex::new(HashMap::new())),
        collab_runs: Arc::new(StdMutex::new(HashMap::new())),
    };
    (temp, state)
}

#[tokio::test]
async fn workflow_handlers_preserve_invalid_edits_and_route_approval_to_its_run() {
    let (_temp, state) = setup();
    let definition = json!({"id":"api-test","name":"API workflow","steps":[
        {"id":"gate","name":"Approval","action":{"kind":"approval","prompt":"Continue?"}},
        {"id":"write","name":"Write","depends_on":["gate"],"action":{"kind":"tool","tool":"write_file","arguments":{"path":"result.txt","content":"ok"}}}
    ],"permission":"full"});
    let created = create_workflow(State(state.clone()), Json(definition))
        .await
        .unwrap()
        .0;
    let id = created["id"].as_str().unwrap().to_owned();
    for body in [
        json!({"steps":"bad"}),
        json!({"steps":[{"id":"broken"}]}),
        json!({"permission":true}),
        json!({"schedule":{"enabled":"yes"}}),
    ] {
        assert!(
            update_workflow(State(state.clone()), AxumPath(id.clone()), Json(body))
                .await
                .is_err()
        );
        assert_eq!(workflow_store(&state).read(&id).unwrap().steps.len(), 2);
    }
    let run = run_workflow(State(state.clone()), AxumPath(id.clone()))
        .await
        .unwrap()
        .0;
    let run_id = run["run_id"].as_str().unwrap().to_owned();
    let record = tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            let history = list_workflow_runs(State(state.clone()), AxumPath(id.clone()))
                .await
                .unwrap()
                .0;
            if history["runs"][0]["status"] == "awaiting_approval" {
                break history["runs"][0].clone();
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .unwrap();
    assert!(record.get("sessions").is_none());
    assert!(record.get("snapshot").is_none());
    assert!(
        delete_workflow(State(state.clone()), AxumPath(id.clone()))
            .await
            .is_err()
    );
    let request = record["pending"]["id"].as_str().unwrap();
    for (target, body) in [
        (
            "wrong-run".to_owned(),
            json!({"request_id":request,"allow":true}),
        ),
        (run_id.clone(), json!({"request_id":request,"allow":"yes"})),
    ] {
        assert!(
            workflow_run_answer(
                State(state.clone()),
                AxumPath((id.clone(), target)),
                Json(body)
            )
            .await
            .is_err()
        );
    }
    let _ = workflow_run_answer(
        State(state.clone()),
        AxumPath((id.clone(), run_id.clone())),
        Json(json!({"request_id":request,"allow":true})),
    )
    .await
    .unwrap();
    tokio::time::timeout(Duration::from_secs(5), async {
        while state.workflow_scheduler.ensure_inactive(&id).is_err() {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .unwrap();
    assert_eq!(
        std::fs::read_to_string(state.cwd.join("result.txt")).unwrap(),
        "ok"
    );
    let history = list_workflow_runs(State(state.clone()), AxumPath(id.clone()))
        .await
        .unwrap()
        .0;
    assert_eq!(history["runs"][0]["status"], "completed");
    assert!(
        workflow_run_action(
            State(state.clone()),
            AxumPath((id, run_id)),
            Json(json!({"action":"recover"}))
        )
        .await
        .is_err()
    );
}

#[tokio::test]
async fn workflow_action_handler_cancels_pending_approval_and_templates_start_unscheduled() {
    let (_temp, state) = setup();
    let template = create_workflow(
        State(state.clone()),
        Json(json!({"template":"env-inspect"})),
    )
    .await
    .unwrap()
    .0;
    assert_eq!(template["schedule"]["enabled"], false);
    let created = create_workflow(
        State(state.clone()),
        Json(json!({"id":"cancel-api","name":"Cancel","steps":[
            {"id":"gate","name":"Gate","action":{"kind":"approval","prompt":"Continue?"}}
        ]})),
    )
    .await
    .unwrap()
    .0;
    let id = created["id"].as_str().unwrap().to_owned();
    let run = run_workflow(State(state.clone()), AxumPath(id.clone()))
        .await
        .unwrap()
        .0;
    let run_id = run["run_id"].as_str().unwrap().to_owned();
    let _ = workflow_run_action(
        State(state.clone()),
        AxumPath((id.clone(), run_id)),
        Json(json!({"action":"cancel"})),
    )
    .await
    .unwrap();
    let history = list_workflow_runs(State(state), AxumPath(id))
        .await
        .unwrap()
        .0;
    assert_eq!(history["runs"][0]["status"], "cancelled");
    assert!(history["runs"][0]["pending"].is_null());
}
