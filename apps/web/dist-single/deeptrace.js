
// DeepTrace 深迹 - AI 对话追踪系统
(function() {
  'use strict';
  
  // DeepTrace 状态管理
  const DeepTraceStore = {
    traces: [],
    metrics: {
      totalRequests: 0,
      totalTokens: 0,
      totalLatency: 0,
      avgLatency: 0,
      tokensPerSecond: 0,
      errorRate: 0
    },
    isVisible: false,
    maxTraces: 50,
    
    // 添加追踪记录
    addTrace(type, name, meta = {}) {
      const trace = {
        id: Date.now() + Math.random(),
        type, // 'request', 'response', 'tool', 'error'
        name,
        meta,
        timestamp: Date.now()
      };
      this.traces.unshift(trace);
      if (this.traces.length > this.maxTraces) {
        this.traces.pop();
      }
      this.updateMetrics();
      return trace;
    },
    
    // 更新统计指标
    updateMetrics() {
      const requests = this.traces.filter(t => t.type === 'request');
      const responses = this.traces.filter(t => t.type === 'response');
      
      this.metrics.totalRequests = requests.length;
      this.metrics.totalTokens = responses.reduce((sum, r) => sum + (r.meta.tokens || 0), 0);
      
      const latencies = responses.map(r => r.meta.latency || 0).filter(l => l > 0);
      if (latencies.length > 0) {
        this.metrics.totalLatency = latencies.reduce((a, b) => a + b, 0);
        this.metrics.avgLatency = this.metrics.totalLatency / latencies.length;
      }
      
      // 计算 tokens/s
      const recentResponses = responses.slice(0, 5);
      if (recentResponses.length > 0) {
        const totalTokens = recentResponses.reduce((sum, r) => sum + (r.meta.tokens || 0), 0);
        const totalTime = recentResponses.reduce((sum, r) => sum + (r.meta.latency || 0), 0) / 1000;
        this.metrics.tokensPerSecond = totalTime > 0 ? Math.round(totalTokens / totalTime) : 0;
      }
      
      const errors = this.traces.filter(t => t.type === 'error');
      this.metrics.errorRate = this.traces.length > 0 ? (errors.length / this.traces.length * 100) : 0;
    },
    
    // 清空追踪
    clear() {
      this.traces = [];
      this.metrics = {
        totalRequests: 0,
        totalTokens: 0,
        totalLatency: 0,
        avgLatency: 0,
        tokensPerSecond: 0,
        errorRate: 0
      };
    },
    
    // 切换面板可见性
    toggle() {
      this.isVisible = !this.isVisible;
    }
  };
  
  // 导出到全局
  window.CoomiDeepTrace = DeepTraceStore;
  
  // 自动追踪 WebSocket 消息
  const originalAddEventListener = EventTarget.prototype.addEventListener;
  EventTarget.prototype.addEventListener = function(type, listener, options) {
    if (type === 'ws-message' || type === 'message') {
      const wrappedListener = function(event) {
        try {
          const data = typeof event.data === 'string' ? JSON.parse(event.data) : event.data;
          if (data.event_type === 'text_chunk') {
            DeepTraceStore.addTrace('response', 'Text Chunk', {
              tokens: data.content?.length || 0,
              latency: data.latency || 0
            });
          } else if (data.event_type === 'tool_start') {
            DeepTraceStore.addTrace('tool', data.tool_name || 'Unknown Tool', {
              arguments: data.arguments
            });
          }
        } catch (e) {}
        return listener.call(this, event);
      };
      return originalAddEventListener.call(this, type, wrappedListener, options);
    }
    return originalAddEventListener.call(this, type, listener, options);
  };
})();
