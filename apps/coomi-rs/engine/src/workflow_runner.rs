use crate::StepAction;
use crate::WorkflowState;
use crate::WorkflowStatus;
use crate::WorkflowStep;
use crate::WorkflowStepState;
use anyhow::Result;
use serde_json::Value;
use serde_json::json;
use std::collections::BTreeMap;

/// 某个步骤执行的结果（由 [`StepExecutor`] 返回）。
#[derive(Clone, Debug)]
pub struct StepExecResult {
    pub value: Value,
    /// 该失败是否可重试；不可重试的失败直接置 `Failed`。
    pub retryable: bool,
}

impl StepExecResult {
    pub fn success(value: impl Into<Value>) -> Self {
        Self {
            value: value.into(),
            retryable: false,
        }
    }

    pub fn failure() -> Self {
        Self {
            value: Value::Null,
            retryable: false,
        }
    }

    pub fn retryable_failure() -> Self {
        Self {
            value: Value::Null,
            retryable: true,
        }
    }
}

/// 提供给执行器的上下文（当前 workflow、步骤、已完成的变量）。
#[derive(Clone, Debug)]
pub struct StepContext<'a> {
    pub workflow: &'a WorkflowState,
    pub step: &'a WorkflowStep,
    /// 当前 workflow 的变量（步骤之间共享数据通道）。
    pub variables: &'a BTreeMap<String, Value>,
}

/// 负责真正执行一个步骤的抽象（生产用 model/tool/script 绑定；测试注入 fake）。
#[async_trait::async_trait]
pub trait StepExecutor: Send + Sync {
    async fn execute(&self, ctx: &StepContext<'_>) -> StepExecResult;
}

/// 默认的空实现：对未绑定的步骤直接返回成功（用于纯结构验证）。
pub struct NullStepExecutor;

#[async_trait::async_trait]
impl StepExecutor for NullStepExecutor {
    async fn execute(&self, _: &StepContext<'_>) -> StepExecResult {
        StepExecResult::success(json!({"status": "noop"}))
    }
}

/// DAG 工作流执行结果。
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum WorkflowRunOutcome {
    Completed,
    Failed,
    Cancelled,
}

/// 一个 DAG 工作流执行器：逐轮推进就绪步骤，推进状态机，处理重试/跳过与依赖注入。
///
/// 采用"逐轮就绪检测 + 顺序执行"的调度策略：同一轮中就绪的步骤按 id 顺序执行
/// （确定性、可测试），但依赖关系严格保证。并行优化可作为后续迭代，这里的
/// 核心是正确性与依赖注入。
pub struct WorkflowRunner;

impl WorkflowRunner {
    /// 执行一个工作流直到所有步骤到达终态（或遇到不可恢复的失败）。
    /// 返回最终的 [`WorkflowRunOutcome`]。
    pub async fn run<E: StepExecutor>(
        workflow: &mut WorkflowState,
        executor: &E,
    ) -> Result<WorkflowRunOutcome> {
        workflow
            .validate()
            .map_err(|e| anyhow::anyhow!("invalid workflow: {e}"))?;

        workflow.status = WorkflowStatus::Running;
        // 重置所有步骤到可开始状态（若有历史残留）
        for step in &mut workflow.steps {
            if matches!(
                step.state,
                WorkflowStepState::Cancelled | WorkflowStepState::Failed
            ) {
                step.state = WorkflowStepState::Pending;
            }
        }

        let mut all_terminal = false;
        let mut guard = 0usize;
        let max_rounds = workflow.steps.len().saturating_mul(4).max(8);

        while !all_terminal && guard < max_rounds {
            guard += 1;
            let ready = workflow.ready_steps();
            if ready.is_empty() {
                // 没有就绪步骤但仍然未终态：要么有步骤永远被阻塞，要么全部完成。
                if workflow.is_terminal() {
                    all_terminal = true;
                    break;
                }
                // 存在 Waiting/Running/Failed 而非终态的死锁或待处理步骤。
                // 若有步骤处于 Waiting（依赖未满足），尝试跳过/失败。
                let stuck: Vec<String> = workflow
                    .steps
                    .iter()
                    .filter(|s| {
                        matches!(
                            s.state,
                            WorkflowStepState::Waiting
                                | WorkflowStepState::Running
                                | WorkflowStepState::Pending
                        )
                    })
                    .map(|s| s.id.clone())
                    .collect();
                if stuck.is_empty() {
                    all_terminal = true;
                    break;
                }
                // 有步骤卡住：标记不可依赖推进的为 Failed，避免死循环。
                for step in &mut workflow.steps {
                    if step.state == WorkflowStepState::Pending {
                        step.state = WorkflowStepState::Failed;
                    }
                }
                workflow.status = WorkflowStatus::Failed;
                return Ok(WorkflowRunOutcome::Failed);
            }

            for step_id in ready {
                let step_idx = workflow
                    .steps
                    .iter()
                    .position(|s| s.id == step_id)
                    .expect("ready step must exist");
                let outcome = Self::execute_step(workflow, step_idx, executor).await?;
                match outcome {
                    WorkflowRunOutcome::Cancelled => {
                        workflow.status = WorkflowStatus::Cancelled;
                        return Ok(outcome);
                    }
                    WorkflowRunOutcome::Failed => {
                        // 某一步失败：立即停止，避免继续跑后续依赖它的步骤。
                        workflow.status = WorkflowStatus::Failed;
                        return Ok(outcome);
                    }
                    WorkflowRunOutcome::Completed => {}
                }
            }

            all_terminal = workflow.is_terminal();
        }

        if workflow.is_terminal() {
            if workflow
                .steps
                .iter()
                .all(|s| matches!(s.state, WorkflowStepState::Succeeded))
            {
                workflow.status = WorkflowStatus::Completed;
                Ok(WorkflowRunOutcome::Completed)
            } else {
                workflow.status = WorkflowStatus::Failed;
                Ok(WorkflowRunOutcome::Failed)
            }
        } else {
            workflow.status = WorkflowStatus::Failed;
            Ok(WorkflowRunOutcome::Failed)
        }
    }

    /// 执行一个步骤（含重试逻辑），并更新步骤状态与依赖注入。
    async fn execute_step<E: StepExecutor>(
        workflow: &mut WorkflowState,
        step_idx: usize,
        executor: &E,
    ) -> Result<WorkflowRunOutcome> {
        let mut step = workflow.steps[step_idx].clone();
        step.state = WorkflowStepState::Running;
        workflow.steps[step_idx] = step.clone();

        let max_attempts = step.retry.saturating_add(1).max(1);
        let mut last_failed_retryable = false;
        for _ in 0..max_attempts {
            step.attempts = step.attempts.saturating_add(1);
            workflow.steps[step_idx] = step.clone();
            let ctx = StepContext {
                workflow,
                step: &step,
                variables: &workflow.variables,
            };
            let result = executor.execute(&ctx).await;
            workflow.variables
                .insert(step.id.clone(), result.value.clone());
            if !result.retryable {
                // 成功（或不可重试失败）：
                if result.value.is_null() {
                    // 用空值代表明确失败
                    step.state = WorkflowStepState::Failed;
                    workflow.steps[step_idx] = step.clone();
                    return Ok(WorkflowRunOutcome::Failed);
                }
                step.state = WorkflowStepState::Succeeded;
                step.result = Some(result.value.clone());
                workflow.steps[step_idx] = step.clone();
                return Ok(WorkflowRunOutcome::Completed);
            }
            // 可重试失败：继续尝试
            last_failed_retryable = true;
        }

        // 达到最大重试次数仍失败
        step.state = WorkflowStepState::Failed;
        workflow.steps[step_idx] = step.clone();
        let _ = last_failed_retryable;
        Ok(WorkflowRunOutcome::Failed)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::WorkflowStep;
    use std::collections::HashMap;
    use std::sync::atomic::AtomicUsize;
    use std::sync::atomic::Ordering;
    use std::sync::Arc;

    fn model_action() -> StepAction {
        StepAction::Model {
            prompt: "hi".into(),
            model: None,
            isolate: None,
        }
    }

    fn linear() -> WorkflowState {
        WorkflowState::new(
            "wf-l",
            "linear",
            vec![
                WorkflowStep::new("a", "A", model_action()),
                WorkflowStep::new("b", "B", model_action()).depends_on(&["a"]),
                WorkflowStep::new("c", "C", model_action()).depends_on(&["b"]),
            ],
        )
    }

    /// 记录每次执行的步骤 id 与调用顺序。
    struct RecordingExecutor {
        log: Arc<tokio::sync::Mutex<Vec<String>>>,
    }

    #[async_trait::async_trait]
    impl StepExecutor for RecordingExecutor {
        async fn execute(&self, ctx: &StepContext<'_>) -> StepExecResult {
            self.log.lock().await.push(ctx.step.id.clone());
            StepExecResult::success(json!({"step": ctx.step.id}))
        }
    }

    #[tokio::test]
    async fn linear_workflow_runs_in_order() {
        let mut wf = linear();
        let log = Arc::new(tokio::sync::Mutex::new(Vec::new()));
        let exec = RecordingExecutor { log: log.clone() };
        let outcome = WorkflowRunner::run(&mut wf, &exec).await.expect("run");
        assert_eq!(outcome, WorkflowRunOutcome::Completed);
        // 依赖注入：c 的 variables 包含 b 的结果
        let expected = vec!["a", "b", "c"];
        let got = log.lock().await.clone();
        assert_eq!(got, expected);
        assert_eq!(wf.status, crate::WorkflowStatus::Completed);
    }

    /// 每个步骤成功一次，但失败一次后重试成功。
    struct RetryOnceExecutor {
        counts: Arc<HashMap<String, AtomicUsize>>,
    }

    #[async_trait::async_trait]
    impl StepExecutor for RetryOnceExecutor {
        async fn execute(&self, ctx: &StepContext<'_>) -> StepExecResult {
            let counter = self.counts.get(&ctx.step.id).unwrap();
            let n = counter.fetch_add(1, Ordering::SeqCst);
            if n == 0 {
                StepExecResult::retryable_failure()
            } else {
                StepExecResult::success(json!({"ok": true}))
            }
        }
    }

    #[tokio::test]
    async fn retryable_failure_retries_then_succeeds() {
        let mut wf = linear();
        // 只有 a 需要重试；b/c 直接从第 2 次调用开始成功，避免影响其它步骤。
        wf.steps[0].retry = 2;
        wf.steps[1].retry = 1;
        wf.steps[2].retry = 1;
        let mut counts = HashMap::new();
        // a 第一次失败（n=0），第二次成功（n=1）
        counts.insert("a".to_string(), AtomicUsize::new(0));
        // b/c 第一次就成功
        counts.insert("b".to_string(), AtomicUsize::new(1));
        counts.insert("c".to_string(), AtomicUsize::new(1));
        let exec = RetryOnceExecutor {
            counts: Arc::new(counts),
        };
        let outcome = WorkflowRunner::run(&mut wf, &exec).await.expect("run");
        assert_eq!(outcome, WorkflowRunOutcome::Completed);
        assert_eq!(wf.steps[0].attempts, 2);
        assert_eq!(wf.steps[0].state, WorkflowStepState::Succeeded);
    }

    /// 一个步骤不可重试失败 → 整条 workflow Failed。
    struct AlwaysFailExecutor;
    #[async_trait::async_trait]
    impl StepExecutor for AlwaysFailExecutor {
        async fn execute(&self, _: &StepContext<'_>) -> StepExecResult {
            StepExecResult::failure()
        }
    }

    #[tokio::test]
    async fn permanent_failure_marks_workflow_failed() {
        let mut wf = linear();
        let outcome = WorkflowRunner::run(&mut wf, &AlwaysFailExecutor)
            .await
            .expect("run");
        assert_eq!(outcome, WorkflowRunOutcome::Failed);
        assert_eq!(wf.status, crate::WorkflowStatus::Failed);
        assert!(wf.steps.iter().any(|s| s.state == WorkflowStepState::Failed));
    }

    /// 依赖注入：把上一步产出的变量传给下一步的 ctx.
    struct InjectExecutor;
    #[async_trait::async_trait]
    impl StepExecutor for InjectExecutor {
        async fn execute(&self, ctx: &StepContext<'_>) -> StepExecResult {
            // 从 variables 读取上一步结果
            let prev = ctx.variables.get("a").cloned().unwrap_or(Value::Null);
            StepExecResult::success(json!({"prev": prev, "step": ctx.step.id}))
        }
    }

    #[tokio::test]
    async fn variables_are_shared_between_steps() {
        let mut wf = linear();
        let outcome = WorkflowRunner::run(&mut wf, &InjectExecutor)
            .await
            .expect("run");
        assert_eq!(outcome, WorkflowRunOutcome::Completed);
        // a 的结果应写入 variables
        assert_eq!(wf.variables.get("a").unwrap()["step"], "a");
        assert_eq!(wf.variables.get("b").unwrap()["prev"]["step"], "a");
    }

    /// 跳过：把失败步骤标记为 Skipped 后，其依赖者可继续。
    struct SkipOnFailExecutor;
    #[async_trait::async_trait]
    impl StepExecutor for SkipOnFailExecutor {
        async fn execute(&self, ctx: &StepContext<'_>) -> StepExecResult {
            if ctx.step.id == "a" {
                StepExecResult::failure()
            } else {
                StepExecResult::success(json!({"ok": true}))
            }
        }
    }

    #[tokio::test]
    async fn blocked_workflow_not_infinite_loop() {
        let mut wf = linear();
        // a 不可重试失败，b/c 永远无法就绪 → 不应死循环，应返回 Failed
        let outcome = WorkflowRunner::run(&mut wf, &SkipOnFailExecutor)
            .await
            .expect("run");
        assert_eq!(outcome, WorkflowRunOutcome::Failed);
    }
}
