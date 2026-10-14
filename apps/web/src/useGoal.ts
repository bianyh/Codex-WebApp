import { useCallback, useEffect, useRef, useState } from "react";
import { goalStateFromEvent } from "./goalState";
import type { GoalState, GoalUpdate, TimelineEvent } from "./types";

type GoalApi = (url: string, init?: RequestInit) => Promise<GoalState>;

export function useGoal(threadId: string | null, authenticated: boolean | null, request: GoalApi) {
  const [state, setState] = useState<GoalState | null>(null);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const selectedRef = useRef(threadId);
  selectedRef.current = threadId;
  const operationRef = useRef(false);
  const generation = useRef(0);
  const loadingRef = useRef<number | null>(null);
  const actionErrorRef = useRef(false);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; generation.current += 1; }; }, []);
  const reload = useCallback(async (initial = false) => {
    if (!threadId || !authenticated || operationRef.current || loadingRef.current !== null) return;
    const sequence = ++generation.current;
    loadingRef.current = sequence;
    if (initial) setLoading(true);
    try {
      const value = await request(`/api/threads/${encodeURIComponent(threadId)}/goal`, { signal: AbortSignal.timeout(15000) });
      if (!mounted.current || selectedRef.current !== threadId || sequence !== generation.current) return;
      setState(value); if (!actionErrorRef.current) setError("");
    } catch (reason) {
      if (mounted.current && selectedRef.current === threadId && sequence === generation.current) setError(reason instanceof Error ? reason.message : "无法读取目标");
    } finally {
      if (loadingRef.current === sequence) {
        loadingRef.current = null;
        if (mounted.current && selectedRef.current === threadId) setLoading(false);
      }
    }
  }, [threadId, authenticated, request]);
  useEffect(() => {
    generation.current += 1;
    setState(null); setError(""); setLoading(false); actionErrorRef.current = false; loadingRef.current = null;
    if (!threadId || !authenticated) return;
    void reload(true);
    const timer = setInterval(() => { if (document.visibilityState !== "hidden") void reload(); }, 5000);
    const visible = () => { if (document.visibilityState === "visible") void reload(); };
    document.addEventListener("visibilitychange", visible);
    return () => { clearInterval(timer); document.removeEventListener("visibilitychange", visible); generation.current += 1; };
  }, [threadId, authenticated, reload]);
  const mutate = useCallback(async (update: GoalUpdate | null) => {
    if (!threadId || operationRef.current) return;
    operationRef.current = true; generation.current += 1;
    actionErrorRef.current = false;
    setBusy(true); setError("");
    try {
      const value = await request(`/api/threads/${encodeURIComponent(threadId)}/goal`, update ? { method: "PATCH", body: JSON.stringify(update) } : { method: "DELETE" });
      if (mounted.current && selectedRef.current === threadId) setState(value);
    } catch (reason) {
      actionErrorRef.current = true;
      if (mounted.current && selectedRef.current === threadId) setError(reason instanceof Error ? reason.message : "目标操作失败");
      throw reason;
    } finally {
      operationRef.current = false;
      if (mounted.current) setBusy(false);
    }
  }, [threadId, request]);
  const refresh = useCallback(async () => { actionErrorRef.current = false; await reload(); }, [reload]);
  const receiveEvent = useCallback((event: TimelineEvent, targetId: string) => {
    if (selectedRef.current !== targetId) return;
    generation.current += 1;
    setState((current) => goalStateFromEvent(current, event, targetId));
  }, []);
  const receiveState = useCallback((value: GoalState, targetId: string) => {
    if (selectedRef.current !== targetId) return;
    generation.current += 1; setState(value);
  }, []);
  const visibleState = state?.goal && state.goal.threadId !== threadId ? null : state;
  return { state: visibleState, busy, loading, error, reload: refresh, mutate, receiveEvent, receiveState };
}
