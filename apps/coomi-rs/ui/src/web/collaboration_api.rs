use super::*;

#[derive(Clone)]
struct PersistedCollabObserver {
    store: CollabStore,
    task: Arc<StdMutex<CollabTask>>,
    agent_id: String,
}

impl PersistedCollabObserver {
    fn update(&self, event_type: &str, content: &str, extra: Value) {
        let mut task = self.task.lock().unwrap_or_else(|p| p.into_inner());
        if let Some(agent) = task.agents.iter_mut().find(|agent| agent.id == self.agent_id) {
            match event_type {
                "collab_agent_chunk" => agent.output.push_str(content),
                "collab_agent_reasoning" => agent.reasoning.push_str(content),
                "collab_agent_tool" => agent.activities.push(coomi_services::CollabActivity {
                    id: Uuid::new_v4().to_string(), kind: "tool".into(), content: content.into(),
                    tool_name: extra.get("tool_name").and_then(Value::as_str).unwrap_or_default().into(),
                    arguments: extra.get("arguments").cloned().unwrap_or(Value::Null),
                    tool_status: extra.get("tool_status").and_then(Value::as_str).unwrap_or_default().into(),
                    ts_ms: chrono::Utc::now().timestamp_millis(),
                }),
                _ => {}
            }
        }
        task.push_event(event_type, json!({"agent_id":self.agent_id,"content":content,"extra":extra}));
        let _ = self.store.save(task.clone());
    }
}
impl AgentObserver for PersistedCollabObserver {
    fn on_event(&self, event: &AgentEvent) {
        match event {
            AgentEvent::Text(text) | AgentEvent::TextDelta(text) => self.update("collab_agent_chunk", text, json!({})),
            AgentEvent::ReasoningDelta(text) => self.update("collab_agent_reasoning", text, json!({})),
            AgentEvent::ToolStarted(call) => self.update("collab_agent_tool", "", json!({"tool_name":call.name,"arguments":call.arguments,"tool_status":"running"})),
            AgentEvent::ToolFinished { call, result } => self.update("collab_agent_tool", &preview(&result.output), json!({"tool_name":call.name,"arguments":call.arguments,"tool_status":if result.success{"completed"}else{"failed"}})),
            _ => {}
        }
    }
}

struct AutoApproval;
#[async_trait]
impl ApprovalHandler for AutoApproval {
    async fn approve(&self, _call: &ToolCall, _reason: &str) -> bool { true }
}

fn collab_store(state: &AppState) -> CollabStore { CollabStore::new(&state.home) }
fn group_store(state: &AppState) -> GroupChatStore { GroupChatStore::new(&state.home) }
fn now() -> i64 { chrono::Utc::now().timestamp_millis() }
fn value_string(body: &Value, key: &str) -> String { body.get(key).and_then(Value::as_str).unwrap_or_default().trim().to_owned() }

pub(super) async fn group_chat_list(State(state): State<AppState>) -> Result<Json<Value>, ApiError> {
    let rooms=group_store(&state).list().map_err(|e|ApiError::internal(format!("读取群聊失败：{e}")))?;
    let rooms=rooms.into_iter().map(|r|json!({"id":r.id,"name":r.name,"topic":r.topic,"status":r.status,"speakMode":r.speak_mode,"memberCount":r.members.len(),"memberColors":r.members.iter().map(|m|m.color.clone()).collect::<Vec<_>>(),"preview":r.messages.last().map(|m|m.content.chars().take(80).collect::<String>()).unwrap_or_default(),"messageCount":r.messages.len(),"updatedAtMs":r.updated_at_ms,"reasoningEffort":r.reasoning_effort})).collect::<Vec<_>>();
    Ok(Json(json!({"rooms":rooms})))
}
pub(super) async fn group_chat_list_full(State(state): State<AppState>) -> Result<Json<Value>, ApiError> { Ok(Json(json!({"rooms":group_store(&state).list().map_err(|e|ApiError::internal(format!("读取群聊失败：{e}")))?}))) }
pub(super) async fn group_chat_get(State(state):State<AppState>,AxumPath(id):AxumPath<String>)->Result<Json<Value>,ApiError>{Ok(Json(json!(group_store(&state).load(&id).map_err(|e|ApiError::not_found(format!("群聊不存在：{e}")))?)))}
pub(super) async fn group_chat_create(State(state):State<AppState>,Json(body):Json<Value>)->Result<Json<Value>,ApiError>{
    let members=serde_json::from_value::<Vec<ChatMember>>(body.get("members").cloned().unwrap_or_else(||json!([]))).map_err(|e|ApiError::bad_request(format!("成员配置错误：{e}")))?;
    let configured=value_string(&body,"workDir"); let work=resolve_studio_workspace(&state,if configured.is_empty(){"/workspace"}else{&configured})?;
    let room=GroupRoom::new(value_string(&body,"name"),value_string(&body,"topic"),body.get("speakMode").or_else(||body.get("mode")).and_then(Value::as_str).unwrap_or("round_robin").into(),members,work.display().to_string());
    Ok(Json(json!(group_store(&state).save(room).map_err(|e|ApiError::bad_request(format!("创建群聊失败：{e}")))?)))
}
pub(super) async fn group_chat_delete(State(state):State<AppState>,AxumPath(id):AxumPath<String>)->Result<Json<Value>,ApiError>{group_store(&state).delete(&id).map_err(|e|ApiError::internal(format!("删除群聊失败：{e}")))?;Ok(Json(json!({"ok":true})))}
pub(super) async fn group_chat_patch(State(state):State<AppState>,AxumPath(id):AxumPath<String>,Json(body):Json<Value>)->Result<Json<Value>,ApiError>{let store=group_store(&state);let mut r=store.load(&id).map_err(|e|ApiError::not_found(e.to_string()))?;if let Some(v)=body.get("name").and_then(Value::as_str){r.name=v.into()}if let Some(v)=body.get("topic").and_then(Value::as_str){r.topic=v.into()}Ok(Json(json!(store.save(r).map_err(|e|ApiError::bad_request(e.to_string()))?)))}
pub(super) async fn group_chat_clear(State(state):State<AppState>,AxumPath(id):AxumPath<String>)->Result<Json<Value>,ApiError>{let s=group_store(&state);let mut r=s.load(&id).map_err(|e|ApiError::not_found(e.to_string()))?;r.messages.clear();r.activities.clear();Ok(Json(json!(s.save(r).map_err(|e|ApiError::internal(e.to_string()))?)))}
pub(super) async fn group_chat_reset_quota(State(state):State<AppState>,AxumPath(id):AxumPath<String>)->Result<Json<Value>,ApiError>{let s=group_store(&state);let mut r=s.load(&id).map_err(|e|ApiError::not_found(e.to_string()))?;r.speak_counts.clear();Ok(Json(json!(s.save(r).map_err(|e|ApiError::internal(e.to_string()))?)))}
pub(super) async fn group_chat_members(State(state):State<AppState>,AxumPath(id):AxumPath<String>,Json(body):Json<Value>)->Result<Json<Value>,ApiError>{let s=group_store(&state);let mut r=s.load(&id).map_err(|e|ApiError::not_found(e.to_string()))?;r.members=serde_json::from_value(body.get("members").cloned().unwrap_or_else(||json!([]))).map_err(|e|ApiError::bad_request(e.to_string()))?;Ok(Json(json!(s.save(r).map_err(|e|ApiError::bad_request(e.to_string()))?)))}
pub(super) async fn group_chat_work_dir(State(state):State<AppState>,AxumPath(id):AxumPath<String>,Json(body):Json<Value>)->Result<Json<Value>,ApiError>{let p=resolve_studio_workspace(&state,&value_string(&body,"path"))?;let s=group_store(&state);let mut r=s.load(&id).map_err(|e|ApiError::not_found(e.to_string()))?;r.work_dir=p.display().to_string();Ok(Json(json!(s.save(r).map_err(|e|ApiError::internal(e.to_string()))?)))}
pub(super) async fn group_chat_topic(State(state):State<AppState>,AxumPath(id):AxumPath<String>,Json(body):Json<Value>)->Result<Json<Value>,ApiError>{let s=group_store(&state);let mut r=s.load(&id).map_err(|e|ApiError::not_found(e.to_string()))?;r.topic=value_string(&body,"topic");Ok(Json(json!(s.save(r).map_err(|e|ApiError::internal(e.to_string()))?)))}
pub(super) async fn group_chat_speak_mode(State(state):State<AppState>,AxumPath(id):AxumPath<String>,Json(body):Json<Value>)->Result<Json<Value>,ApiError>{let s=group_store(&state);let mut r=s.load(&id).map_err(|e|ApiError::not_found(e.to_string()))?;r.speak_mode=value_string(&body,"speakMode");Ok(Json(json!(s.save(r).map_err(|e|ApiError::bad_request(e.to_string()))?)))}
pub(super) async fn group_chat_host_allow(State(state):State<AppState>,AxumPath(id):AxumPath<String>,Json(body):Json<Value>)->Result<Json<Value>,ApiError>{let s=group_store(&state);let mut r=s.load(&id).map_err(|e|ApiError::not_found(e.to_string()))?;r.host_allow=serde_json::from_value(body.get("allow").cloned().unwrap_or_else(||json!([]))).unwrap_or_default();Ok(Json(json!(s.save(r).map_err(|e|ApiError::internal(e.to_string()))?)))}
pub(super) async fn group_chat_effort(State(state):State<AppState>,AxumPath(id):AxumPath<String>,Json(body):Json<Value>)->Result<Json<Value>,ApiError>{let s=group_store(&state);let mut r=s.load(&id).map_err(|e|ApiError::not_found(e.to_string()))?;r.reasoning_effort=value_string(&body,"reasoningEffort");Ok(Json(json!(s.save(r).map_err(|e|ApiError::internal(e.to_string()))?)))}
pub(super) async fn group_chat_paths_add(State(state):State<AppState>,AxumPath(id):AxumPath<String>,Json(body):Json<Value>)->Result<Json<Value>,ApiError>{let s=group_store(&state);let mut r=s.load(&id).map_err(|e|ApiError::not_found(e.to_string()))?;let mut paths=serde_json::from_value::<Vec<String>>(body.get("paths").cloned().unwrap_or_else(||json!([]))).unwrap_or_default();r.context_paths.append(&mut paths);r.context_paths.sort();r.context_paths.dedup();Ok(Json(json!(s.save(r).map_err(|e|ApiError::internal(e.to_string()))?)))}
pub(super) async fn group_chat_paths_clear(State(state):State<AppState>,AxumPath(id):AxumPath<String>)->Result<Json<Value>,ApiError>{let s=group_store(&state);let mut r=s.load(&id).map_err(|e|ApiError::not_found(e.to_string()))?;r.context_paths.clear();Ok(Json(json!(s.save(r).map_err(|e|ApiError::internal(e.to_string()))?)))}
pub(super) async fn group_chat_activities(State(state):State<AppState>,AxumPath((id,member)):AxumPath<(String,String)>)->Result<Json<Value>,ApiError>{let r=group_store(&state).load(&id).map_err(|e|ApiError::not_found(e.to_string()))?;Ok(Json(json!({"activities":r.activities.into_iter().filter(|a|a.member_id==member).collect::<Vec<_>>() }))) }
pub(super) async fn group_chat_cancel(State(state):State<AppState>,AxumPath(id):AxumPath<String>)->Json<Value>{if let Some(h)=state.group_chat_runs.lock().unwrap_or_else(|p|p.into_inner()).remove(&id){h.abort();}if let Ok(mut r)=group_store(&state).load(&id){r.status="idle".into();let _=group_store(&state).save(r);}Json(json!({"ok":true}))}

fn select_room_members(room:&mut GroupRoom,content:&str,to:&str)->Vec<ChatMember>{
    let eligible=|m:&&ChatMember| m.quota==0||room.speak_counts.get(&m.id).copied().unwrap_or(0)<m.quota;
    let mut selected=if to!="all"{room.members.iter().filter(|m|m.id==to||m.name==to).cloned().collect()}else{room.members.iter().filter(|m|content.contains(&format!("@{}",m.name))||content.contains(&format!("@{}",m.id))).cloned().collect::<Vec<_>>()};
    if selected.is_empty(){selected=match room.speak_mode.as_str(){"open"=>room.members.iter().filter(eligible).cloned().collect(),"host"=>room.members.iter().filter(|m|room.host_allow.contains(&m.id)).filter(eligible).cloned().collect(),_=>{let options=room.members.iter().filter(eligible).cloned().collect::<Vec<_>>();if options.is_empty(){vec![]}else{let m=options[room.next_speaker%options.len()].clone();room.next_speaker=(room.next_speaker+1)%options.len();vec![m]}}};}
    selected
}

pub(super) async fn group_chat_send(State(state):State<AppState>,AxumPath(id):AxumPath<String>,Json(body):Json<Value>)->Result<Json<Value>,ApiError>{
    if state.group_chat_runs.lock().unwrap_or_else(|p|p.into_inner()).contains_key(&id){return Err(ApiError::conflict("群聊成员正在发言"));}
    let store=group_store(&state);let mut room=store.load(&id).map_err(|e|ApiError::not_found(e.to_string()))?;let content=value_string(&body,"content");if content.is_empty(){return Err(ApiError::bad_request("content is required"));}
    let to=body.get("to").and_then(Value::as_str).unwrap_or("all").to_owned();let attachments=body.get("paths").or_else(||body.get("attachments")).cloned().and_then(|v|serde_json::from_value(v).ok()).unwrap_or_default();let reply_to=body.get("replyTo").and_then(Value::as_str).map(str::to_owned);
    room.messages.push(GroupMessage{id:Uuid::new_v4().to_string(),from:"user".into(),to:to.clone(),content:content.clone(),attachments,reply_to,at_ms:now(),kind:"text".into()});
    let selected=select_room_members(&mut room,&content,&to);room.status="running".into();let room=store.save(room).map_err(|e|ApiError::internal(e.to_string()))?;
    let state2=state.clone();let id2=id.clone();let response_id=id2.clone();let handle=tokio::spawn(async move{let registry=match ProviderRegistry::load(&providers_path(&state2.home)){Ok(v)=>Arc::new(v),Err(_)=>return};let shared=Arc::new(StdMutex::new(room));let mut hs=vec![];for member in selected{let registry=Arc::clone(&registry);let shared=Arc::clone(&shared);let state=state2.clone();let id=id2.clone();let message_content=content.clone();hs.push(tokio::spawn(async move{let selector=if member.model_selector.is_empty(){None}else{Some(member.model_selector.as_str())};let pc=match registry.resolve(selector){Ok(v)=>v,Err(e)=>{record_group_error(&state,&id,&member,&e.to_string());return}};let provider=match HttpModelProvider::new(pc){Ok(v)=>v,Err(e)=>{record_group_error(&state,&id,&member,&e.to_string());return}};let snapshot=shared.lock().unwrap_or_else(|p|p.into_inner()).clone();let cwd=PathBuf::from(&snapshot.work_dir);let policy=match SecurityPolicy::new(&cwd,AccessMode::FullAccess){Ok(v)=>v,Err(e)=>{record_group_error(&state,&id,&member,&e.to_string());return}};let roster=snapshot.members.iter().map(|m|format!("- {}（@{}）：{}",m.name,m.id,m.prompt)).collect::<Vec<_>>().join("\n");let history=snapshot.messages.iter().rev().take(24).rev().map(|m|format!("{} -> {}：{}",m.from,m.to,m.content)).collect::<Vec<_>>().join("\n");let paths=snapshot.context_paths.join("\n");let sys=format!("你是群聊成员“{}”（@{}）。职责：{}\n群成员：\n{}\n话题：{}\n共享工作目录：{}\n授权上下文路径：\n{}\n可以 @其他成员继续协作。",member.name,member.id,member.prompt,roster,snapshot.topic,snapshot.work_dir,paths);let mut prompt=system_prompt(&state.home,&cwd,AccessMode::FullAccess,&coomi_engine::discover_project_instructions(&cwd).unwrap_or_default(),false).await;prompt.push_str("\n\n");prompt.push_str(&sys);let tools=CoreTools::new(cwd.clone(),policy).with_skills_directory(state.home.join("skills")).with_config_home(state.home.clone()).with_mcp_runtime(Arc::new(McpRuntime::load(&state.home).await)).with_memory(Arc::new(MemoryManager::new(&state.home,&cwd)));let mut session=Session::new(provider.provider_id(),provider.model(),cwd);let observer=GroupObserver{state:state.clone(),room_id:id.clone(),member:member.clone()};let user=format!("群聊历史：\n{}\n\n本轮消息：{}",history,message_content);match Agent::new(prompt).with_max_tool_rounds(64).with_reasoning_effort(snapshot.reasoning_effort.clone()).run_turn(&mut session,user,&provider,&tools,&AutoApproval,&observer).await{Ok(output)=>record_group_reply(&state,&id,&member,output),Err(e)=>record_group_error(&state,&id,&member,&format!("{e:#}"))}}));}for h in hs{let _=h.await;}if let Ok(mut r)=GroupChatStore::new(&state2.home).load(&id2){r.status="idle".into();let _=GroupChatStore::new(&state2.home).save(r);}state2.group_chat_runs.lock().unwrap_or_else(|p|p.into_inner()).remove(&id2);});state.group_chat_runs.lock().unwrap_or_else(|p|p.into_inner()).insert(id,handle.abort_handle());Ok(Json(json!({"room":store.load(&response_id).unwrap_or_else(|_|GroupRoom::new("群聊".into(),"".into(),"round_robin".into(),vec![],state.cwd.display().to_string()))})))
}

#[derive(Clone)]struct GroupObserver{state:AppState,room_id:String,member:ChatMember}
impl AgentObserver for GroupObserver{fn on_event(&self,event:&AgentEvent){let(kind,detail)=match event{AgentEvent::ReasoningDelta(s)=>("reasoning",s.clone()),AgentEvent::Text(s)|AgentEvent::TextDelta(s)=>("chunk",s.clone()),AgentEvent::ToolStarted(c)=>("tool",format!("{} {}",c.name,c.arguments)),AgentEvent::ToolFinished{call,result}=>("tool",format!("{}: {}",call.name,preview(&result.output))),_=>return};if let Ok(mut r)=GroupChatStore::new(&self.state.home).load(&self.room_id){r.activities.push(MemberActivity{id:Uuid::new_v4().to_string(),member_id:self.member.id.clone(),kind:kind.into(),detail,message_id:None,at_ms:now()});let _=GroupChatStore::new(&self.state.home).save(r);}}}
fn record_group_reply(state:&AppState,id:&str,m:&ChatMember,output:String){let s=GroupChatStore::new(&state.home);if let Ok(mut r)=s.load(id){*r.speak_counts.entry(m.id.clone()).or_default()+=1;r.messages.push(GroupMessage{id:Uuid::new_v4().to_string(),from:m.id.clone(),to:"all".into(),content:output,attachments:vec![],reply_to:None,at_ms:now(),kind:"text".into()});let _=s.save(r);}}
fn record_group_error(state:&AppState,id:&str,m:&ChatMember,error:&str){let s=GroupChatStore::new(&state.home);if let Ok(mut r)=s.load(id){r.activities.push(MemberActivity{id:Uuid::new_v4().to_string(),member_id:m.id.clone(),kind:"error".into(),detail:error.into(),message_id:None,at_ms:now()});r.messages.push(GroupMessage{id:Uuid::new_v4().to_string(),from:"system".into(),to:m.id.clone(),content:format!("{} 回复失败：{}",m.name,error),attachments:vec![],reply_to:None,at_ms:now(),kind:"error".into()});let _=s.save(r);}}

pub(super) async fn collab_list(State(state):State<AppState>)->Result<Json<Value>,ApiError>{Ok(Json(json!({"tasks":collab_store(&state).list().map_err(|e|ApiError::internal(e.to_string()))?})))}
pub(super) async fn collab_get(State(state):State<AppState>,AxumPath(id):AxumPath<String>)->Result<Json<Value>,ApiError>{Ok(Json(json!(collab_store(&state).load(&id).map_err(|e|ApiError::not_found(e.to_string()))?)))}
pub(super) async fn collab_get_lite(State(state):State<AppState>,AxumPath(id):AxumPath<String>)->Result<Json<Value>,ApiError>{let t=collab_store(&state).load(&id).map_err(|e|ApiError::not_found(e.to_string()))?;Ok(Json(json!({"id":t.id,"title":t.title,"objective":t.objective,"status":t.status,"mode":t.mode,"agents":t.agents,"updatedAtMs":t.updated_at_ms,"summary":t.summary})))}
pub(super) async fn collab_create(State(state):State<AppState>,Json(body):Json<Value>)->Result<Json<Value>,ApiError>{let settings=body.get("settings").cloned().unwrap_or_else(||json!({}));let roles=serde_json::from_value::<Vec<CollabRole>>(settings.get("roles").cloned().unwrap_or_else(||json!([]))).map_err(|e|ApiError::bad_request(e.to_string()))?;let cwd=resolve_studio_workspace(&state,body.get("cwd").and_then(Value::as_str).unwrap_or("/workspace"))?;let mut task=CollabTask::new(value_string(&body,"title"),body.get("task").and_then(Value::as_str).unwrap_or_default().into(),value_string(&body,"session_id"),cwd.display().to_string(),settings.get("mode").and_then(Value::as_str).unwrap_or("parallel").into(),roles);task.attachments=serde_json::from_value(body.get("attachments").cloned().unwrap_or_else(||json!([]))).unwrap_or_default();let task=collab_store(&state).save(task).map_err(|e|ApiError::bad_request(e.to_string()))?;let id=task.id.clone();if body.get("auto_start").and_then(Value::as_bool).unwrap_or(true){spawn_collab(state.clone(),id.clone())?;}Ok(Json(json!({"taskId":id,"task":task})))}
pub(super) async fn collab_delete(State(state):State<AppState>,AxumPath(id):AxumPath<String>)->Result<Json<Value>,ApiError>{if let Some(h)=state.collab_runs.lock().unwrap_or_else(|p|p.into_inner()).remove(&id){h.abort();}collab_store(&state).delete(&id).map_err(|e|ApiError::internal(e.to_string()))?;Ok(Json(json!({"ok":true})))}
pub(super) async fn collab_start(State(state):State<AppState>,AxumPath(id):AxumPath<String>)->Result<Json<Value>,ApiError>{spawn_collab(state.clone(),id.clone())?;Ok(Json(json!({"ok":true,"taskId":id})))}
pub(super) async fn collab_cancel(State(state):State<AppState>,AxumPath(id):AxumPath<String>)->Result<Json<Value>,ApiError>{cancel_collab(&state,&id,"cancelled");Ok(Json(json!({"ok":true})))}
pub(super) async fn collab_interrupt(State(state):State<AppState>,AxumPath(id):AxumPath<String>)->Result<Json<Value>,ApiError>{cancel_collab(&state,&id,"interrupted");Ok(Json(json!({"ok":true})))}
fn cancel_collab(state:&AppState,id:&str,status:&str){if let Some(h)=state.collab_runs.lock().unwrap_or_else(|p|p.into_inner()).remove(id){h.abort();}let s=collab_store(state);if let Ok(mut t)=s.load(id){t.status=status.into();t.push_event("collab_finished",json!({"status":status}));let _=s.save(t);}}
pub(super) async fn collab_retry(State(state):State<AppState>,AxumPath(id):AxumPath<String>)->Result<Json<Value>,ApiError>{let s=collab_store(&state);let old=s.load(&id).map_err(|e|ApiError::not_found(e.to_string()))?;let old_messages=old.messages.clone();let mut t=CollabTask::new(format!("{}（重试）",old.title),old.objective,old.session_id,old.cwd,old.mode,old.roles);t.retry_count=old.retry_count+1;t.messages=old_messages;let t=s.save(t).map_err(|e|ApiError::internal(e.to_string()))?;let nid=t.id.clone();spawn_collab(state,nid.clone())?;Ok(Json(json!({"taskId":nid,"new_task_id":nid})))}
pub(super) async fn collab_message(State(state):State<AppState>,AxumPath(id):AxumPath<String>,Json(body):Json<Value>)->Result<Json<Value>,ApiError>{
    let s=collab_store(&state);let mut t=s.load(&id).map_err(|e|ApiError::not_found(e.to_string()))?;
    let c=value_string(&body,"content");if c.is_empty(){return Err(ApiError::bad_request("content is required"));}
    let running=state.collab_runs.lock().unwrap_or_else(|p|p.into_inner()).contains_key(&id);
    if running { return Err(ApiError::conflict("协同任务正在运行，请先停止或等待本轮结束")); }
    let to=body.get("to").and_then(Value::as_str).unwrap_or("all").to_owned();
    t.messages.push(coomi_services::CollabMessage{id:Uuid::new_v4().to_string(),from:"user".into(),to:to.clone(),content:c.clone(),ts_ms:now()});
    t.push_event("collab_agent_message",json!({"from":"user","to":to,"content":c}));
    s.save(t).map_err(|e|ApiError::internal(e.to_string()))?;
    // 追加指令不是只写入记录：空闲任务立即开始新一轮。运行中拒绝追加，
    // 避免用户误以为当前已固定上下文的并行波次能够读到中途消息。
    spawn_collab(state,id.clone())?;
    Ok(Json(json!({"ok":true,"taskId":id,"started":true})))
}
pub(super) async fn collab_events(State(state):State<AppState>,AxumPath(id):AxumPath<String>,Query(q):Query<HashMap<String,String>>)->Result<Json<Value>,ApiError>{let since=q.get("since_seq").and_then(|v|v.parse().ok()).unwrap_or(0);let t=collab_store(&state).load(&id).map_err(|e|ApiError::not_found(e.to_string()))?;let events=t.events.into_iter().filter(|e|e.seq>since).collect::<Vec<_>>();let next=events.last().map(|e|e.seq).unwrap_or(since);Ok(Json(json!({"events":events,"next_seq":next})))}
pub(super) async fn collab_artifacts(State(state):State<AppState>,AxumPath(id):AxumPath<String>)->Result<Json<Value>,ApiError>{let t=collab_store(&state).load(&id).map_err(|e|ApiError::not_found(e.to_string()))?;Ok(Json(json!({"artifacts":t.artifacts})))}
pub(super) async fn collab_preview(State(state):State<AppState>,Query(q):Query<HashMap<String,String>>)->Result<Json<Value>,ApiError>{let path=q.get("path").ok_or_else(||ApiError::bad_request("path required"))?;let file=sandboxed_path(&state,path)?;let meta=fs::metadata(&file).map_err(|e|ApiError::bad_request(e.to_string()))?;if meta.is_dir(){return Ok(Json(json!({"kind":"binary","size":0})))}if meta.len()>2*1024*1024{return Ok(Json(json!({"kind":"binary","size":meta.len()})))}match fs::read_to_string(&file){Ok(content)=>Ok(Json(json!({"kind":"text","content":content,"size":meta.len()}))),Err(_)=>Ok(Json(json!({"kind":"binary","size":meta.len()})))}}

fn spawn_collab(state:AppState,id:String)->Result<(),ApiError>{if state.collab_runs.lock().unwrap_or_else(|p|p.into_inner()).contains_key(&id){return Err(ApiError::conflict("协同任务已在运行"));}let s=collab_store(&state);let mut t=s.load(&id).map_err(|e|ApiError::not_found(e.to_string()))?;t.status="starting".into();t.started_at_ms=Some(now());t.finished_at_ms=None;for agent in &mut t.agents{agent.status="waiting".into();agent.current_message.clear();agent.started_at_ms=None;agent.finished_at_ms=None;}t.push_event("collab_task_started",json!({"task_id":id}));let t=s.save(t).map_err(|e|ApiError::internal(e.to_string()))?;let shared=Arc::new(StdMutex::new(t));let st=state.clone();let rid=id.clone();let h=tokio::spawn(async move{run_collab(st.clone(),shared).await;st.collab_runs.lock().unwrap_or_else(|p|p.into_inner()).remove(&rid);});state.collab_runs.lock().unwrap_or_else(|p|p.into_inner()).insert(id,h.abort_handle());Ok(())}
async fn run_collab(state: AppState, shared: Arc<StdMutex<CollabTask>>) {
    let registry = match ProviderRegistry::load(&providers_path(&state.home)) {
        Ok(value) => Arc::new(value),
        Err(error) => { finish_collab(&state, &shared, "failed", error.to_string()); return; }
    };
    {
        let mut task = shared.lock().unwrap_or_else(|value| value.into_inner());
        task.status = "running".into();
        let phase = if task.mode == "orchestrated" { "planning" } else { "execution" };
        let mode = task.mode.clone();
        task.push_event("collab_orchestration_phase", json!({"phase": phase, "mode": mode}));
        let _ = collab_store(&state).save(task.clone());
    }
    let snapshot = shared.lock().unwrap_or_else(|value| value.into_inner()).clone();
    let roster = snapshot.roles.iter().map(|role| format!("- {}（{}）：{}", role.name, role.id, role.prompt)).collect::<Vec<_>>().join("\n");
    let attachment_text = snapshot.attachments.join("、");
    let task_mode = snapshot.mode.clone();
    let objective = if let Some(message) = snapshot.messages.last() { format!("总目标：{}\n\n本轮追加指令：{}", snapshot.objective, message.content) } else { snapshot.objective.clone() };
    let mut prior_outputs = String::new();
    let roles = snapshot.roles.clone();
    for (index, role) in roles.iter().cloned().enumerate() {
        if task_mode == "parallel" {
            // parallel is handled as independent snapshots below; prior output stays empty.
        } else if index > 0 {
            let mut task = shared.lock().unwrap_or_else(|value| value.into_inner());
            task.push_event("collab_orchestration_phase", json!({"phase":"handoff","agent_id":role.id,"index":index}));
            let _ = collab_store(&state).save(task.clone());
        }
        let role_name = role.name.clone(); let mode2 = task_mode.clone();
        let state2 = state.clone(); let registry2 = Arc::clone(&registry); let shared2 = Arc::clone(&shared);
        let roster2 = roster.clone(); let objective2 = objective.clone(); let attachments2 = attachment_text.clone(); let prior2 = prior_outputs.clone();
        let run = async move {
            { let mut task=shared2.lock().unwrap_or_else(|v|v.into_inner()); if let Some(agent)=task.agents.iter_mut().find(|a|a.id==role.id){agent.status="running".into();agent.started_at_ms=Some(now())} task.push_event("collab_agent_status",json!({"agent_id":role.id,"status":"running"}));let _=collab_store(&state2).save(task.clone()); }
            let provider_config=match registry2.resolve(Some(&role.model_selector)){Ok(v)=>v,Err(e)=>{fail_collab_agent(&state2,&shared2,&role.id,e.to_string());return String::new()}};
            let provider=match HttpModelProvider::new(provider_config){Ok(v)=>v,Err(e)=>{fail_collab_agent(&state2,&shared2,&role.id,e.to_string());return String::new()}};
            let cwd=PathBuf::from(&shared2.lock().unwrap_or_else(|v|v.into_inner()).cwd);
            let policy=match SecurityPolicy::new(&cwd,AccessMode::FullAccess){Ok(v)=>v,Err(e)=>{fail_collab_agent(&state2,&shared2,&role.id,e.to_string());return String::new()}};
            let mut prompt=system_prompt(&state2.home,&cwd,AccessMode::FullAccess,&coomi_engine::discover_project_instructions(&cwd).unwrap_or_default(),false).await;
            let mode_rule=match mode2.as_str(){"coordinated"=>"阅读前序成员交接，补充而不是重复，并明确给下一位的交接结论。","orchestrated"=>if index==0{"先拆分计划、风险和验收标准，再完成你的职责。"}else{"严格依据主控计划和前序产出执行，指出依赖是否满足。"},_=>"基于同一上下文独立完成职责，避免依赖其他成员的未完成结果。"};
            prompt.push_str(&format!("\n\n你是协同任务角色“{}”。职责：{}\n团队：\n{}\n模式要求：{}\n前序交接：\n{}\n工作目录：{}\n附件：{}\n输出必须包含结果、证据、风险和交接。",role.name,role.prompt,roster2,mode_rule,prior2,cwd.display(),attachments2));
            let tools=CoreTools::new(cwd.clone(),policy).with_skills_directory(state2.home.join("skills")).with_config_home(state2.home.clone()).with_mcp_runtime(Arc::new(McpRuntime::load(&state2.home).await)).with_memory(Arc::new(MemoryManager::new(&state2.home,&cwd)));
            let mut session=Session::new(provider.provider_id(),provider.model(),cwd);let observer=PersistedCollabObserver{store:collab_store(&state2),task:Arc::clone(&shared2),agent_id:role.id.clone()};
            match Agent::new(prompt).with_max_tool_rounds(96).with_reasoning_effort("high").run_turn(&mut session,objective2,&provider,&tools,&AutoApproval,&observer).await{Ok(out)=>{complete_collab_agent(&state2,&shared2,&role.id,out.clone());out},Err(e)=>{fail_collab_agent(&state2,&shared2,&role.id,format!("{e:#}"));String::new()}}
        };
        if task_mode == "parallel" {
            // Spawn every remaining role from the same deterministic snapshot.
            let mut handles=vec![tokio::spawn(run)];
            for role2 in roles.iter().skip(index+1).cloned(){let state2=state.clone();let registry2=Arc::clone(&registry);let shared2=Arc::clone(&shared);let roster2=roster.clone();let objective2=objective.clone();let attachments2=attachment_text.clone();handles.push(tokio::spawn(async move{run_collab_role(state2,registry2,shared2,role2,roster2,objective2,attachments2,String::new(),"parallel").await}));}
            for handle in handles { let _=handle.await; }
            break;
        } else { prior_outputs.push_str(&format!("\n\n## {}\n{}",role_name,run.await)); }
    }
    let (outputs,failed,total)={let task=shared.lock().unwrap_or_else(|v|v.into_inner());(task.agents.iter().map(|a|format!("## {}\n{}",a.name,a.output)).collect::<Vec<_>>().join("\n\n"),task.agents.iter().filter(|a|a.status=="failed").count(),task.agents.len())};
    let status=if failed==0{"completed"}else if failed==total{"failed"}else{"partial"};finish_collab(&state,&shared,status,outputs)
}

async fn run_collab_role(state:AppState,registry:Arc<ProviderRegistry>,shared:Arc<StdMutex<CollabTask>>,role:CollabRole,roster:String,objective:String,attachments:String,prior:String,mode:&str)->String{
    {let mut task=shared.lock().unwrap_or_else(|v|v.into_inner());if let Some(agent)=task.agents.iter_mut().find(|a|a.id==role.id){agent.status="running".into();agent.started_at_ms=Some(now())}task.push_event("collab_agent_status",json!({"agent_id":role.id,"status":"running"}));let _=collab_store(&state).save(task.clone());}
    let pc=match registry.resolve(Some(&role.model_selector)){Ok(v)=>v,Err(e)=>{fail_collab_agent(&state,&shared,&role.id,e.to_string());return String::new()}};let provider=match HttpModelProvider::new(pc){Ok(v)=>v,Err(e)=>{fail_collab_agent(&state,&shared,&role.id,e.to_string());return String::new()}};let cwd=PathBuf::from(&shared.lock().unwrap_or_else(|v|v.into_inner()).cwd);let policy=match SecurityPolicy::new(&cwd,AccessMode::FullAccess){Ok(v)=>v,Err(e)=>{fail_collab_agent(&state,&shared,&role.id,e.to_string());return String::new()}};let mut prompt=system_prompt(&state.home,&cwd,AccessMode::FullAccess,&coomi_engine::discover_project_instructions(&cwd).unwrap_or_default(),false).await;prompt.push_str(&format!("\n\n你是“{}”。职责：{}\n团队：\n{}\n执行模式：{}\n前序：{}\n目录：{}\n附件：{}\n独立交付结果、证据与风险。",role.name,role.prompt,roster,mode,prior,cwd.display(),attachments));let tools=CoreTools::new(cwd.clone(),policy).with_skills_directory(state.home.join("skills")).with_config_home(state.home.clone()).with_mcp_runtime(Arc::new(McpRuntime::load(&state.home).await)).with_memory(Arc::new(MemoryManager::new(&state.home,&cwd)));let mut session=Session::new(provider.provider_id(),provider.model(),cwd);let observer=PersistedCollabObserver{store:collab_store(&state),task:Arc::clone(&shared),agent_id:role.id.clone()};match Agent::new(prompt).with_max_tool_rounds(96).with_reasoning_effort("high").run_turn(&mut session,objective,&provider,&tools,&AutoApproval,&observer).await{Ok(out)=>{complete_collab_agent(&state,&shared,&role.id,out.clone());out},Err(e)=>{fail_collab_agent(&state,&shared,&role.id,format!("{e:#}"));String::new()}}
}
fn complete_collab_agent(state:&AppState,t:&Arc<StdMutex<CollabTask>>,id:&str,out:String){let mut t=t.lock().unwrap_or_else(|p|p.into_inner());if let Some(a)=t.agents.iter_mut().find(|a|a.id==id){a.status="completed".into();a.output=out;a.finished_at_ms=Some(now())}t.push_event("collab_agent_status",json!({"agent_id":id,"status":"completed"}));collect_artifacts(&mut t,id);let _=collab_store(state).save(t.clone());}
fn fail_collab_agent(state:&AppState,t:&Arc<StdMutex<CollabTask>>,id:&str,e:String){let mut t=t.lock().unwrap_or_else(|p|p.into_inner());if let Some(a)=t.agents.iter_mut().find(|a|a.id==id){a.status="failed".into();a.current_message=e.clone();a.finished_at_ms=Some(now())}t.push_event("collab_agent_status",json!({"agent_id":id,"status":"failed","message":e}));let _=collab_store(state).save(t.clone());}
fn finish_collab(state:&AppState,t:&Arc<StdMutex<CollabTask>>,status:&str,summary:String){let mut t=t.lock().unwrap_or_else(|p|p.into_inner());t.status=status.into();t.summary=summary.clone();t.finished_at_ms=Some(now());t.push_event("collab_finished",json!({"status":status,"summary":summary}));let _=collab_store(state).save(t.clone());}
fn collect_artifacts(t:&mut CollabTask,agent_id:&str){let Some(a)=t.agents.iter().find(|a|a.id==agent_id)else{return};let text=a.output.clone();for token in text.split_whitespace(){let p=token.trim_matches(|c:char|"`'\"(),[]<>".contains(c));if !p.starts_with('/')||!p.contains('.') {continue}let path=PathBuf::from(p);if !path.is_file()||t.artifacts.iter().any(|x|x.path==p){continue}let meta=fs::metadata(&path).ok();t.artifacts.push(CollabArtifact{id:Uuid::new_v4().to_string(),path:p.into(),name:path.file_name().and_then(|n|n.to_str()).unwrap_or(p).into(),kind:path.extension().and_then(|n|n.to_str()).unwrap_or("file").into(),action:"created".into(),agent_id:agent_id.into(),size:meta.as_ref().map(|m|m.len()).unwrap_or(0),modified_at_ms:now()});}}
