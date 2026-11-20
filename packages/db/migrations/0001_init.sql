--
-- 0001_init — Snaglet's complete initial schema and built-in rows.
--
-- The one migration a fresh database applies. Sections, in order: extensions,
-- schemas, types, functions, tables (with views, sequences and comments),
-- column defaults, constraints, indexes, triggers, foreign keys, the database
-- defaults, then the built-in rows (the catalog seeds from ./seeds/ and the
-- feature flags).
--
-- The DDL is `pg_dump --schema-only --no-owner --no-privileges` output (the
-- `_migrations` ledger excluded: the runner creates it), regrouped by
-- section and stripped of pg_dump's per-object headers.
--
-- FORWARD-ONLY: once released, never edit this file. Schema changes land as
-- new numbered migrations (0002_...); a change to catalog rows ALSO updates
-- ./seeds/ so resets and catalog healing stay current.
--
-- The runner executes this file as one multi-statement batch (a single
-- transaction). Session settings changed here are reset before the seed rows.
--

SET check_function_bodies = false;
SELECT pg_catalog.set_config('search_path', '', false);

--
-- Extensions
--

CREATE EXTENSION IF NOT EXISTS pg_trgm WITH SCHEMA public;

CREATE EXTENSION IF NOT EXISTS vector WITH SCHEMA public;

--
-- Schemas
--

CREATE SCHEMA user_tables;

--
-- Types
--

CREATE TYPE public.node_type AS ENUM (
    'container',
    'doc',
    'thread',
    'message',
    'memory',
    'thread_summary',
    'file',
    'image',
    'tool',
    'sketch',
    'post',
    'calendar_event',
    'discussion'
);

--
-- Functions
--

CREATE FUNCTION public.activity_hard_delete(retention interval) RETURNS integer
    LANGUAGE plpgsql
    AS $$
DECLARE
  affected integer;
BEGIN
  DELETE FROM agent_activity_log
   WHERE created_at < NOW() - retention;

  GET DIAGNOSTICS affected = ROW_COUNT;
  RETURN affected;
END;
$$;

CREATE FUNCTION public.activity_payload_truncate(retention interval) RETURNS integer
    LANGUAGE plpgsql
    AS $$
DECLARE
  affected integer;
BEGIN
  UPDATE agent_activity_log
     SET content    = NULL,
         tool_input = NULL,
         tool_output = NULL
   WHERE created_at < NOW() - retention
     AND (content IS NOT NULL OR tool_input IS NOT NULL OR tool_output IS NOT NULL);

  GET DIAGNOSTICS affected = ROW_COUNT;
  RETURN affected;
END;
$$;

CREATE FUNCTION public.agents_block_ghost_delete() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF OLD.id = 'ghost' THEN
    RAISE EXCEPTION 'The ghost system agent is permanent and cannot be deleted';
  END IF;
  RETURN OLD;
END;
$$;

CREATE FUNCTION public.archive_ttl_sweep(ttl_interval interval DEFAULT '30 days'::interval) RETURNS TABLE(deleted_containers integer, deleted_other integer)
    LANGUAGE plpgsql
    AS $$
DECLARE
  v_now      timestamptz := now();
  v_cutoff   timestamptz := v_now - ttl_interval;
  v_containers int := 0;
  v_other      int := 0;
BEGIN
  -- Detach expired containers nested inside other expired containers, so the
  -- bulk DELETE below never UPDATEs (via orphan_null_on_container_delete) a
  -- tuple it also deletes in the same command -- Postgres forbids that ("tuple
  -- to be updated was already modified by an operation triggered by the current
  -- command"). Setting container_id = NULL is the one mutation
  -- archived_node_immutable_guard permits on archived rows.
  UPDATE public.nodes child
     SET container_id = NULL
   WHERE child.archived     = true
     AND child.archived_at  < v_cutoff
     AND child.type         = 'container'
     AND child.container_id IN (
       SELECT id FROM public.nodes
        WHERE archived   = true
          AND archived_at < v_cutoff
          AND type       = 'container'
     );

  -- Containers first -- each DELETE cascades through its cohort.
  WITH expired_containers AS (
    SELECT id FROM public.nodes
     WHERE archived   = true
       AND archived_at < v_cutoff
       AND type       = 'container'
  ), deleted_c AS (
    DELETE FROM public.nodes
     WHERE id IN (SELECT id FROM expired_containers)
    RETURNING id
  )
  SELECT count(*)::int INTO v_containers FROM deleted_c;

  -- Remaining expired non-container nodes that weren't already cascaded
  -- with a deleted container.
  WITH deleted_o AS (
    DELETE FROM public.nodes
     WHERE archived   = true
       AND archived_at < v_cutoff
       AND type       <> 'container'
    RETURNING id
  )
  SELECT count(*)::int INTO v_other FROM deleted_o;

  deleted_containers := v_containers;
  deleted_other      := v_other;
  RETURN NEXT;
END;
$$;

CREATE FUNCTION public.archived_node_immutable_guard() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  -- If the row was not archived before this UPDATE, no immutability applies.
  IF OLD.archived = false THEN
    RETURN NEW;
  END IF;

  -- Restore-with-move: archived true→false in this UPDATE. Allow.
  IF NEW.archived = false THEN
    RETURN NEW;
  END IF;

  -- container_id changes are forbidden EXCEPT the system orphan-null write.
  IF NEW.container_id IS DISTINCT FROM OLD.container_id
     AND NEW.container_id IS NOT NULL THEN
    RAISE EXCEPTION
      'Archived node % is immutable: cannot change container_id (was % → %).',
      OLD.id, OLD.container_id, NEW.container_id
      USING ERRCODE = 'check_violation';
  END IF;

  -- project_id follows the same rule: only the orphan-null write may touch it.
  IF NEW.project_id IS DISTINCT FROM OLD.project_id
     AND NEW.project_id IS NOT NULL THEN
    RAISE EXCEPTION
      'Archived node % is immutable: cannot change project_id (was % → %).',
      OLD.id, OLD.project_id, NEW.project_id
      USING ERRCODE = 'check_violation';
  END IF;

  -- sort_order changes are always forbidden on archived rows.
  IF NEW.sort_order IS DISTINCT FROM OLD.sort_order THEN
    RAISE EXCEPTION
      'Archived node % is immutable: cannot change sort_order (was % → %).',
      OLD.id, OLD.sort_order, NEW.sort_order
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$$;

CREATE FUNCTION public.calendar_event_series_guard() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE
    parent public.calendar_events%ROWTYPE;
BEGIN
    IF TG_OP = 'UPDATE' AND (
        NEW.recurring_event_id IS DISTINCT FROM OLD.recurring_event_id
        OR NEW.original_start_at IS DISTINCT FROM OLD.original_start_at
        OR NEW.original_start_date IS DISTINCT FROM OLD.original_start_date
        OR NEW.ical_uid IS DISTINCT FROM OLD.ical_uid
    ) THEN
        RAISE EXCEPTION 'Calendar occurrence identity is immutable; create a new event instead'
            USING ERRCODE = '23514';
    END IF;

    IF NEW.recurring_event_id IS NOT NULL THEN
        SELECT * INTO parent FROM public.calendar_events WHERE id = NEW.recurring_event_id FOR UPDATE;
        IF NOT FOUND OR parent.recurring_event_id IS NOT NULL OR cardinality(parent.recurrence) = 0 THEN
            RAISE EXCEPTION 'Calendar exception must reference a recurring root' USING ERRCODE = '23514';
        END IF;
        IF parent.calendar_id <> NEW.calendar_id OR parent.time_kind <> NEW.time_kind THEN
            RAISE EXCEPTION 'Calendar exception must share its series calendar and time kind' USING ERRCODE = '23514';
        END IF;
        NEW.ical_uid := parent.ical_uid;
    ELSIF TG_OP = 'UPDATE' AND (
        cardinality(NEW.recurrence) = 0
        OR NEW.calendar_id IS DISTINCT FROM OLD.calendar_id
        OR NEW.time_kind IS DISTINCT FROM OLD.time_kind
    ) AND EXISTS (SELECT 1 FROM public.calendar_events WHERE recurring_event_id = OLD.id) THEN
        RAISE EXCEPTION 'Update or remove calendar exceptions before changing their series kind or calendar'
            USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
END;
$$;

CREATE FUNCTION public.calendar_valid_recurrence(lines text[]) RETURNS boolean
    LANGUAGE sql IMMUTABLE
    AS $$
    SELECT COALESCE(array_ndims(lines), 1) = 1
       AND cardinality(lines) <= 64
       AND NOT EXISTS (
           SELECT 1 FROM unnest(lines) AS line
            WHERE line IS NULL OR char_length(line) > 2048
               OR line ~ E'[\r\n]'
               OR line !~ '^(RRULE:|EXRULE:|RDATE(;[^:]+)?:|EXDATE(;[^:]+)?:).+'
       );
$$;

CREATE FUNCTION public.calendar_valid_timezone(zone text) RETURNS boolean
    LANGUAGE sql STABLE
    AS $$
    SELECT EXISTS (SELECT 1 FROM pg_catalog.pg_timezone_names WHERE name = zone);
$$;

CREATE FUNCTION public.cascade_archive_descendants() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF OLD.archived = true OR NEW.archived = false THEN
    RETURN NEW;
  END IF;

  -- One UPDATE covers immediate (direct) children and the node's project
  -- threads. Each child's UPDATE re-fires this trigger and continues the
  -- cascade downward.
  UPDATE public.nodes
     SET archived    = true,
         archived_at = NEW.archived_at
   WHERE (container_id = NEW.id OR project_id = NEW.id)
     AND archived = false;

  RETURN NEW;
END;
$$;

CREATE FUNCTION public.cascade_archive_thread_memories() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF NEW.type <> 'thread' THEN
    RETURN NEW;
  END IF;

  -- Archive direction (false → true).
  IF OLD.archived = false AND NEW.archived = true THEN
    UPDATE public.nodes n
       SET archived    = true,
           archived_at = NEW.archived_at
      FROM public.memories m
     WHERE m.id = n.id
       AND m.source_thread_id = NEW.id
       AND n.archived = false;
  END IF;

  -- Restore direction (true → false). Scope by OLD.archived_at cohort.
  IF OLD.archived = true AND NEW.archived = false AND OLD.archived_at IS NOT NULL THEN
    UPDATE public.nodes n
       SET archived    = false,
           archived_at = NULL
      FROM public.memories m
     WHERE m.id = n.id
       AND m.source_thread_id = NEW.id
       AND n.archived = true
       AND n.archived_at = OLD.archived_at;
  END IF;

  RETURN NEW;
END;
$$;

CREATE FUNCTION public.cascade_restore_descendants() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF OLD.archived = false OR NEW.archived = true THEN
    RETURN NEW;
  END IF;
  IF OLD.archived_at IS NULL THEN
    -- No cohort to scope by — nothing to cascade.
    RETURN NEW;
  END IF;

  UPDATE public.nodes
     SET archived    = false,
         archived_at = NULL
   WHERE (container_id = NEW.id OR project_id = NEW.id)
     AND archived = true
     AND archived_at = OLD.archived_at;

  RETURN NEW;
END;
$$;

CREATE FUNCTION public.check_nodes_container_no_cycle() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE
  walker_id   text;
  depth       int := 0;
  max_depth   int := 64;
BEGIN
  -- Fast-path: no parent → can't cycle
  IF NEW.container_id IS NULL THEN
    RETURN NEW;
  END IF;

  -- Fast-path: direct self-reference
  IF NEW.container_id = NEW.id THEN
    RAISE EXCEPTION 'nodes.container_id cycle: node % cannot be its own container', NEW.id
      USING ERRCODE = 'check_violation';
  END IF;

  -- Walk up from NEW.container_id; if we ever reach NEW.id, that's a cycle.
  walker_id := NEW.container_id;
  WHILE walker_id IS NOT NULL LOOP
    depth := depth + 1;
    IF depth > max_depth THEN
      RAISE EXCEPTION 'nodes.container_id cycle check exceeded max depth % (starting from node %)', max_depth, NEW.id
        USING ERRCODE = 'check_violation';
    END IF;

    IF walker_id = NEW.id THEN
      RAISE EXCEPTION 'nodes.container_id cycle detected: node % would create a cycle via container_id chain', NEW.id
        USING ERRCODE = 'check_violation';
    END IF;

    SELECT container_id INTO walker_id
    FROM public.nodes
    WHERE id = walker_id;
  END LOOP;

  RETURN NEW;
END;
$$;

CREATE FUNCTION public.cleanup_links_on_node_archive() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF OLD.archived = false AND NEW.archived = true THEN
    DELETE FROM public.links
     WHERE source_id = NEW.id
        OR target_id = NEW.id;
  END IF;
  RETURN NEW;
END;
$$;

CREATE FUNCTION public.containers_project_category_guard() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  -- Promotion (NULL → 'project') is allowed: no thread or table scope can
  -- point at a plain folder, so nothing needs rehoming.
  IF NEW.category IS DISTINCT FROM OLD.category
     AND OLD.category = 'project' THEN
    RAISE EXCEPTION
      'Container % category cannot change out of ''project'' after creation (was %, got %).',
      OLD.id, OLD.category, COALESCE(NEW.category, 'null')
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE FUNCTION public.docs_update_search_text() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
begin
  new.search_text :=
    to_tsvector('english', coalesce(new.title, '') || ' ' || coalesce(new.content, ''));
  return new;
end;
$$;

CREATE FUNCTION public.snaglet_text_array_to_string(parts text[]) RETURNS text
    LANGUAGE sql IMMUTABLE PARALLEL SAFE
    AS $$ SELECT COALESCE(array_to_string(parts, ' '), '') $$;

CREATE FUNCTION public.is_project_container(candidate text) RETURNS boolean
    LANGUAGE sql STABLE
    AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.containers c
     WHERE c.id = candidate AND c.category = 'project'
  );
$$;

CREATE FUNCTION public.link_triple_is_valid(p_source_type text, p_relation text, p_target_type text) RETURNS boolean
    LANGUAGE sql IMMUTABLE
    AS $$
  SELECT CASE p_relation
    WHEN 'references' THEN
      (p_source_type IN ('doc','thread')
       AND p_target_type IN (
         'doc','thread','container','image',
         'memory','thread_summary'
       ))
      OR (p_source_type = 'doc'
       AND p_target_type IN ('tool','message'))
    WHEN 'summarizes' THEN
      (p_source_type = 'thread_summary' AND p_target_type IN ('thread','message'))
      OR (p_source_type = 'memory' AND p_target_type IN ('thread','message','thread_summary'))
    WHEN 'context' THEN
      (p_source_type = 'memory' AND p_target_type IN ('thread','message','thread_summary'))
      OR (p_source_type = 'thread' AND p_target_type IN ('thread','doc'))
      OR (p_source_type = 'message' AND p_target_type IN ('thread','message'))
    ELSE FALSE
  END;
$$;

CREATE FUNCTION public.nodes_project_scope_guard() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF NEW.project_id IS NULL THEN
    RETURN NEW;
  END IF;
  IF NEW.type <> 'thread' THEN
    RAISE EXCEPTION
      'nodes.project_id is only carried by threads: node % is a %.',
      NEW.id, NEW.type
      USING ERRCODE = 'check_violation';
  END IF;
  IF NOT public.is_project_container(NEW.project_id) THEN
    RAISE EXCEPTION
      'nodes.project_id % is not a project container (node %).',
      NEW.project_id, NEW.id
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE FUNCTION public.notify_node_restored() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF OLD.archived = true AND NEW.archived = false THEN
    PERFORM pg_notify('node_restored', NEW.id);
  END IF;
  RETURN NEW;
END;
$$;

CREATE FUNCTION public.orphan_null_on_container_delete() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF OLD.type <> 'container' THEN
    RETURN OLD;
  END IF;

  UPDATE public.nodes
     SET container_id = NULL
   WHERE container_id = OLD.id
     AND archived = true
     AND archived_at IS DISTINCT FROM OLD.archived_at;

  UPDATE public.nodes
     SET project_id = NULL
   WHERE project_id = OLD.id
     AND archived = true
     AND archived_at IS DISTINCT FROM OLD.archived_at;

  RETURN OLD;
END;
$$;

CREATE FUNCTION public.rebuild_doc_inline_links(p_doc_id text) RETURNS void
    LANGUAGE plpgsql
    AS $$
DECLARE
  v_content text;
  v_targets text[] := ARRAY[]::text[];
  v_match   text;
BEGIN
  SELECT content INTO v_content FROM public.docs WHERE id = p_doc_id;
  IF v_content IS NULL THEN
    RETURN;
  END IF;

  -- The fragment grammar (line ranges, written by hand too, and heading
  -- sections) is LINE_FRAGMENT_SQL_SOURCE / HEADING_FRAGMENT_SOURCE in
  -- packages/shared/utils; docLineRef.test.ts keeps this copy identical.
  FOR v_match IN
    SELECT m[2]
    FROM regexp_matches(
      v_content,
      '!?\[([^\]]*)\]\(([a-z][a-z0-9_]*-[A-Za-z0-9_-]+)(?:#(?:[Ll][0-9]+(?::[0-9]+)?(?:(?:[-\u2010-\u2015\u2212]|%2[Dd]|%[Ee]2%80%9[0-5]|%[Ee]2%88%92)[Ll]?[0-9]+(?::[0-9]+)?)?|h[1-6]?=[^)\s#.]+(?:\.\.h[1-6]?=[^)\s#.]+)?))?\)',
      'g'
    ) AS m
  LOOP
    v_targets := array_append(v_targets, v_match);
  END LOOP;

  SELECT COALESCE(array_agg(DISTINCT t), ARRAY[]::text[])
    INTO v_targets
  FROM unnest(v_targets) AS t
  WHERE t <> p_doc_id;

  DELETE FROM public.links
   WHERE source_id = p_doc_id
     AND relation  = 'references'
     AND target_id <> ALL(v_targets);

  IF array_length(v_targets, 1) IS NOT NULL THEN
    INSERT INTO public.links (id, source_id, target_id, relation, metadata)
    SELECT 'link-' || gen_random_uuid(), p_doc_id, t, 'references', '{}'::jsonb
      FROM unnest(v_targets) AS t
     WHERE EXISTS (
             SELECT 1 FROM public.nodes n
              WHERE n.id = t
                AND public.link_triple_is_valid('doc', 'references', n.type::text)
           )
        ON CONFLICT (source_id, target_id, relation) DO NOTHING;
  END IF;
END;
$$;

CREATE FUNCTION public.relink_doc_on_restore() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF NEW.type <> 'doc' THEN
    RETURN NEW;
  END IF;
  IF OLD.archived = false OR NEW.archived = true THEN
    RETURN NEW;
  END IF;

  PERFORM public.rebuild_doc_inline_links(NEW.id);
  RETURN NEW;
END;
$$;

CREATE FUNCTION public.subagents_delete_helper_thread() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
  BEGIN
    IF OLD.thread_id IS NOT NULL THEN
      DELETE FROM public.agent_activity_log a
       USING public.runs r
       WHERE r.id = a.run_id AND r.thread_id = OLD.thread_id;
      DELETE FROM public.nodes
       WHERE id IN (SELECT m.id FROM public.messages m WHERE m.thread_id = OLD.thread_id);
      DELETE FROM public.nodes WHERE id = OLD.thread_id;
    END IF;
    RETURN OLD;
  END
  $$;

CREATE FUNCTION public.sync_doc_links() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE
  v_source_id text := NEW.id;
  v_match     text;
  v_target_id text;
  v_targets   text[] := ARRAY[]::text[];
BEGIN
  -- Only react to content changes (or initial insert).
  IF TG_OP = 'UPDATE' AND NEW.content IS NOT DISTINCT FROM OLD.content THEN
    RETURN NEW;
  END IF;

  -- Extract all inline-link target ids from content.
  -- regexp_matches with 'g' returns one row per match. The fragment grammar
  -- is LINE_FRAGMENT_SQL_SOURCE / HEADING_FRAGMENT_SOURCE in
  -- packages/shared/utils; docLineRef.test.ts keeps this copy identical.
  IF NEW.content IS NOT NULL THEN
    FOR v_match IN
      SELECT m[2]
      FROM regexp_matches(
        NEW.content,
        '!?\[([^\]]*)\]\(([a-z][a-z0-9_]*-[A-Za-z0-9_-]+)(?:#(?:[Ll][0-9]+(?::[0-9]+)?(?:(?:[-\u2010-\u2015\u2212]|%2[Dd]|%[Ee]2%80%9[0-5]|%[Ee]2%88%92)[Ll]?[0-9]+(?::[0-9]+)?)?|h[1-6]?=[^)\s#.]+(?:\.\.h[1-6]?=[^)\s#.]+)?))?\)',
        'g'
      ) AS m
    LOOP
      v_targets := array_append(v_targets, v_match);
    END LOOP;
  END IF;

  -- Dedupe + self-link removal.
  SELECT COALESCE(array_agg(DISTINCT t), ARRAY[]::text[])
    INTO v_targets
  FROM unnest(v_targets) AS t
  WHERE t <> v_source_id;

  -- Atomic replace: delete this doc's existing 'references' outbound links
  -- whose target is NOT in the new set, then insert the new ones (skipping
  -- targets that don't exist in nodes, that a doc may not reference, or that
  -- are already present).
  DELETE FROM links
  WHERE source_id = v_source_id
    AND relation  = 'references'
    AND target_id <> ALL(v_targets);

  IF array_length(v_targets, 1) IS NOT NULL THEN
    INSERT INTO links (id, source_id, target_id, relation, metadata)
    SELECT 'link-' || gen_random_uuid(), v_source_id, t, 'references', '{}'::jsonb
    FROM unnest(v_targets) AS t
    WHERE EXISTS (
            SELECT 1 FROM nodes n
             WHERE n.id = t
               AND public.link_triple_is_valid('doc', 'references', n.type::text)
          )
    ON CONFLICT (source_id, target_id, relation) DO NOTHING;
  END IF;

  RETURN NEW;
END;
$$;

CREATE FUNCTION public.table_catalog_project_scope_guard() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF NEW.project_id IS NULL THEN
    RETURN NEW;
  END IF;
  IF NOT public.is_project_container(NEW.project_id) THEN
    RAISE EXCEPTION
      'table_catalog.project_id % is not a project container (table %).',
      NEW.project_id, NEW.id
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE FUNCTION public.update_thread_last_message() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE
  msg_created_at timestamptz;
BEGIN
  BEGIN
    msg_created_at := COALESCE(NEW.created_at, NOW());
    UPDATE public.threads
       SET last_message_at = msg_created_at
     WHERE id = NEW.thread_id
       AND (last_message_at IS NULL OR msg_created_at >= last_message_at);
  EXCEPTION WHEN OTHERS THEN
    NULL;
  END;
  RETURN NEW;
END;
$$;

CREATE FUNCTION public.validate_link_triple() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE
  v_src_type TEXT;
  v_tgt_type TEXT;
BEGIN
  SELECT type::text INTO v_src_type FROM nodes WHERE id = NEW.source_id;
  SELECT type::text INTO v_tgt_type FROM nodes WHERE id = NEW.target_id;

  IF v_src_type IS NULL THEN
    RAISE EXCEPTION 'link source_id % does not exist in nodes', NEW.source_id;
  END IF;
  IF v_tgt_type IS NULL THEN
    RAISE EXCEPTION 'link target_id % does not exist in nodes', NEW.target_id;
  END IF;

  IF NOT public.link_triple_is_valid(v_src_type, NEW.relation, v_tgt_type) THEN
    RAISE EXCEPTION 'invalid link triple: (%, %, %) is not in the allowed matrix',
      v_src_type, NEW.relation, v_tgt_type;
  END IF;

  RETURN NEW;
END;
$$;

--
-- Tables, views and sequences (with their comments)
--

CREATE TABLE public.agent_activity_log (
    id text DEFAULT (gen_random_uuid())::text NOT NULL,
    agent_id text NOT NULL,
    action_type text NOT NULL,
    trigger_type text NOT NULL,
    reason text,
    token_estimate integer DEFAULT 0,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    tool text,
    tool_input jsonb,
    tool_output jsonb,
    run_id text,
    duration_ms integer,
    content text,
    CONSTRAINT agent_activity_log_action_type_check CHECK ((action_type = ANY (ARRAY['create_post'::text, 'comment'::text, 'message_reply'::text, 'skip'::text, 'browse_web'::text, 'tool_call'::text, 'tool_discovery_failure'::text, 'thinking'::text]))),
    CONSTRAINT agent_activity_log_trigger_type_check CHECK ((trigger_type = ANY (ARRAY['cron'::text, 'chat_nudge'::text, 'mention'::text, 'message_received'::text, 'manual'::text])))
);

CREATE TABLE public.agent_skill_assignments (
    id text DEFAULT ('skillasg-'::text || (gen_random_uuid())::text) NOT NULL,
    agent_id text NOT NULL,
    skill_id text NOT NULL,
    thread_id text,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE public.agents (
    id text DEFAULT ('agent-'::text || (gen_random_uuid())::text) NOT NULL,
    name text NOT NULL,
    role text,
    avatar_url text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    system_prompt text,
    identity text,
    model_id text,
    provider_id text,
    credential_id text,
    tool_access_mode text,
    tool_access_allow_list jsonb,
    tool_access_deny_list jsonb,
    tool_overrides jsonb,
    fallbacks jsonb,
    disable_model_fallback boolean DEFAULT false NOT NULL,
    mcp_servers jsonb DEFAULT '[]'::jsonb NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    voice text,
    archived boolean DEFAULT false NOT NULL,
    archived_at timestamp with time zone,
    deleted_at timestamp with time zone,
    max_tool_calls_per_turn integer,
    max_duration_seconds integer,
    tool_access_advertise_allowed_only boolean DEFAULT false NOT NULL,
    trusted_tool_calls boolean DEFAULT false NOT NULL,
    parent_agent_id text,
    cursor_flower text,
    cursor_color text,
    cursor_spec jsonb,
    dm_enabled boolean DEFAULT true NOT NULL,
    CONSTRAINT agents_archived_consistency_chk CHECK ((((archived = false) AND (archived_at IS NULL)) OR ((archived = true) AND (archived_at IS NOT NULL)))),
    CONSTRAINT agents_deleted_implies_archived_chk CHECK (((deleted_at IS NULL) OR (archived = true))),
    CONSTRAINT agents_parent_agent_not_self_chk CHECK (((parent_agent_id IS NULL) OR (parent_agent_id <> id)))
);

COMMENT ON COLUMN public.agents.tool_access_advertise_allowed_only IS 'Opt-in strict advertisement for allow_list mode: advertise exactly the allow list ∩ reachable tools, plus the search_tools/get_tool_schema discovery riders (excluded if access-gated for the agent). Inert unless tool_access_mode = allow_list. Default false = existing full-core advertisement. Trims advertisement only — callability and ask-escalation are unchanged.';

COMMENT ON COLUMN public.agents.cursor_flower IS 'Flower id for the agent cursor (daisy, tulip, ...); NULL = per-agent default.';

COMMENT ON COLUMN public.agents.cursor_color IS 'Optional #rrggbb tint for the agent cursor; NULL = the flower''s default color.';

COMMENT ON COLUMN public.agents.cursor_spec IS 'CursorSpec JSON ({v:1, shape, colors}) for the agent cursor flower; NULL = default derived from the agent id.';

CREATE TABLE public.automations (
    id text NOT NULL,
    name text NOT NULL,
    prompt text NOT NULL,
    status text DEFAULT 'active'::text NOT NULL,
    trigger text DEFAULT 'time'::text NOT NULL,
    when_kind text NOT NULL,
    at timestamp with time zone,
    rrule text,
    time_of_day text,
    starts_on date,
    every_ms bigint,
    tz text NOT NULL,
    calendar_id text,
    thread_id text NOT NULL,
    agent_id text NOT NULL,
    schedule_id text,
    created_by_agent_id text,
    created_by_member_id text,
    consecutive_failures integer DEFAULT 0 NOT NULL,
    paused_reason text,
    created_run_id text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    window_start text,
    window_end text,
    unattended_policy text DEFAULT 'skip'::text NOT NULL,
    CONSTRAINT automations_cancelled_schedule_check CHECK (((status <> 'cancelled'::text) OR (schedule_id IS NULL))),
    CONSTRAINT automations_consecutive_failures_check CHECK ((consecutive_failures >= 0)),
    CONSTRAINT automations_every_ms_check CHECK (((every_ms IS NULL) OR ((every_ms >= 60000) AND (every_ms <= 604800000)))),
    CONSTRAINT automations_name_check CHECK (((char_length(name) >= 1) AND (char_length(name) <= 80))),
    CONSTRAINT automations_paused_reason_check CHECK (((paused_reason IS NULL) OR ((status = 'paused'::text) AND (paused_reason = ANY (ARRAY['user'::text, 'agent'::text, 'failures'::text]))))),
    CONSTRAINT automations_prompt_check CHECK (((char_length(prompt) >= 1) AND (char_length(prompt) <= 4000))),
    CONSTRAINT automations_status_check CHECK ((status = ANY (ARRAY['active'::text, 'paused'::text, 'finished'::text, 'cancelled'::text]))),
    CONSTRAINT automations_time_of_day_check CHECK (((time_of_day IS NULL) OR (time_of_day ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'::text))),
    CONSTRAINT automations_trigger_check CHECK ((trigger = 'time'::text)),
    CONSTRAINT automations_tz_check CHECK (((char_length(tz) >= 1) AND (char_length(tz) <= 64))),
    CONSTRAINT automations_unattended_policy_check CHECK ((unattended_policy = ANY (ARRAY['skip'::text, 'auto-approve-allowed'::text]))),
    CONSTRAINT automations_when_kind_check CHECK ((when_kind = ANY (ARRAY['once'::text, 'repeat'::text, 'interval'::text, 'first_open'::text]))),
    CONSTRAINT automations_when_shape_check CHECK ((((when_kind = 'once'::text) AND (at IS NOT NULL) AND (rrule IS NULL) AND (time_of_day IS NULL) AND (starts_on IS NULL) AND (every_ms IS NULL)) OR ((when_kind = 'repeat'::text) AND (rrule IS NOT NULL) AND (time_of_day IS NOT NULL) AND (starts_on IS NOT NULL) AND (at IS NULL) AND (every_ms IS NULL)) OR ((when_kind = 'interval'::text) AND (every_ms IS NOT NULL) AND (at IS NULL) AND (rrule IS NULL) AND (time_of_day IS NULL) AND (starts_on IS NULL)) OR ((when_kind = 'first_open'::text) AND (time_of_day IS NOT NULL) AND (at IS NULL) AND (rrule IS NULL) AND (starts_on IS NULL) AND (every_ms IS NULL)))),
    CONSTRAINT automations_window_check CHECK ((((window_start IS NULL) AND (window_end IS NULL)) OR ((when_kind = 'interval'::text) AND (window_start IS NOT NULL) AND (window_end IS NOT NULL) AND (window_start ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'::text) AND (window_end ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'::text) AND (window_start <> window_end))))
);

COMMENT ON TABLE public.automations IS 'Scheduled agent wakes. Written only by AutomationService; each non-cancelled row owns one schedules row (schedule_id).';

COMMENT ON COLUMN public.automations.rrule IS 'repeat only: normalised RRULE body (no DTSTART/TZID), expanded from starts_on at time_of_day in tz.';

COMMENT ON COLUMN public.automations.time_of_day IS 'repeat: the HH:mm in tz each wake falls at; first_open: the earliest HH:mm in tz it may run each day.';

COMMENT ON COLUMN public.automations.created_run_id IS 'The agent run that created it (the per-run creation cap).';

COMMENT ON COLUMN public.automations.window_start IS 'interval only: the daily window opens at this HH:mm in tz (with window_end); runs fall at it, then every every_ms.';

COMMENT ON COLUMN public.automations.window_end IS 'interval only: the last HH:mm in tz a run may fall at each day (inclusive); before window_start crosses midnight.';

COMMENT ON COLUMN public.automations.unattended_policy IS 'What a run this automation starts does with a tool call that would ask: skip | auto-approve-allowed.';

CREATE TABLE public.calendar_events (
    id text NOT NULL,
    calendar_id text NOT NULL,
    title text DEFAULT ''::text NOT NULL,
    description text DEFAULT ''::text NOT NULL,
    location text DEFAULT ''::text NOT NULL,
    status text DEFAULT 'confirmed'::text NOT NULL,
    time_kind text NOT NULL,
    time_zone text NOT NULL,
    start_at timestamp with time zone,
    end_at timestamp with time zone,
    start_date date,
    end_date date,
    recurrence text[] DEFAULT '{}'::text[] NOT NULL,
    recurring_event_id text,
    original_start_at timestamp with time zone,
    original_start_date date,
    ical_uid text DEFAULT ((gen_random_uuid())::text || '@snaglet.local'::text) NOT NULL,
    revision integer DEFAULT 1 NOT NULL,
    created_by text,
    last_edited_by text,
    CONSTRAINT calendar_events_ical_uid_check CHECK ((btrim(ical_uid) <> ''::text)),
    CONSTRAINT calendar_events_occurrence_chk CHECK ((((recurring_event_id IS NULL) AND (original_start_at IS NULL) AND (original_start_date IS NULL)) OR ((recurring_event_id IS NOT NULL) AND (recurring_event_id <> id) AND (cardinality(recurrence) = 0) AND (((time_kind = 'timed'::text) AND (original_start_at IS NOT NULL) AND isfinite(original_start_at) AND (original_start_date IS NULL)) OR ((time_kind = 'all_day'::text) AND (original_start_date IS NOT NULL) AND isfinite(original_start_date) AND (original_start_at IS NULL)))))),
    CONSTRAINT calendar_events_recurrence_check CHECK (public.calendar_valid_recurrence(recurrence)),
    CONSTRAINT calendar_events_revision_check CHECK ((revision > 0)),
    CONSTRAINT calendar_events_status_check CHECK ((status = ANY (ARRAY['confirmed'::text, 'tentative'::text, 'cancelled'::text]))),
    CONSTRAINT calendar_events_time_chk CHECK ((((time_kind = 'timed'::text) AND (start_at IS NOT NULL) AND (end_at IS NOT NULL) AND isfinite(start_at) AND isfinite(end_at) AND (end_at > start_at) AND (start_date IS NULL) AND (end_date IS NULL)) OR ((time_kind = 'all_day'::text) AND (start_date IS NOT NULL) AND (end_date IS NOT NULL) AND isfinite(start_date) AND isfinite(end_date) AND (end_date > start_date) AND (start_at IS NULL) AND (end_at IS NULL)) OR ((status = 'cancelled'::text) AND (recurring_event_id IS NOT NULL) AND (start_at IS NULL) AND (end_at IS NULL) AND (start_date IS NULL) AND (end_date IS NULL)))),
    CONSTRAINT calendar_events_time_kind_check CHECK ((time_kind = ANY (ARRAY['timed'::text, 'all_day'::text]))),
    CONSTRAINT calendar_events_time_zone_check CHECK (public.calendar_valid_timezone(time_zone)),
    CONSTRAINT calendar_events_title_check CHECK ((char_length(title) <= 500))
);

COMMENT ON COLUMN public.calendar_events.end_at IS 'Exclusive end instant; start_at/end_at are used only for timed events.';

COMMENT ON COLUMN public.calendar_events.end_date IS 'Exclusive end date; all-day events never use UTC midnight as a date surrogate.';

COMMENT ON COLUMN public.calendar_events.ical_uid IS 'Calendar interchange UID, shared by a series and its exceptions; not a Google event ID.';

CREATE TABLE public.calendars (
    id text DEFAULT ('calendar-'::text || (gen_random_uuid())::text) NOT NULL,
    title text NOT NULL,
    description text DEFAULT ''::text NOT NULL,
    time_zone text DEFAULT 'UTC'::text NOT NULL,
    color text,
    revision integer DEFAULT 1 NOT NULL,
    created_by text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    is_default boolean DEFAULT false NOT NULL,
    sort_order integer DEFAULT 0 NOT NULL,
    CONSTRAINT calendars_revision_check CHECK ((revision > 0)),
    CONSTRAINT calendars_sort_order_check CHECK ((sort_order >= 0)),
    CONSTRAINT calendars_time_zone_check CHECK (public.calendar_valid_timezone(time_zone)),
    CONSTRAINT calendars_title_check CHECK (((char_length(btrim(title)) >= 1) AND (char_length(btrim(title)) <= 500)))
);

COMMENT ON COLUMN public.calendars.is_default IS 'The "Default calendar" the service creates on first use; at most one.';

COMMENT ON COLUMN public.calendars.sort_order IS 'Manual sidebar order, 0-based.';

CREATE TABLE public.containers (
    id text DEFAULT ('container-'::text || (gen_random_uuid())::text) NOT NULL,
    name text NOT NULL,
    description text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    category text,
    folder_path text,
    github_url text,
    created_by text,
    last_edited_by text,
    file_indexing_enabled boolean DEFAULT true NOT NULL,
    CONSTRAINT containers_category_chk CHECK (((category IS NULL) OR (category = 'project'::text)))
);

COMMENT ON COLUMN public.containers.file_indexing_enabled IS 'Project facet: index the linked folder''s files. Indexing runs only while this and snaglet.config.json embeddings.enabled are both on.';

CREATE TABLE public.doc_edit_state (
    doc_id text NOT NULL,
    last_content_edit_at timestamp with time zone,
    last_editor_kind text,
    last_editor_id text,
    last_editor_name text,
    content_hash text,
    last_logged_hash text
);

CREATE TABLE public.doc_snapshots (
    id text NOT NULL,
    doc_id text NOT NULL,
    content text NOT NULL,
    content_bytes integer NOT NULL,
    label text,
    reason text,
    created_by text,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE public.docs (
    id text DEFAULT ('doc-'::text || (gen_random_uuid())::text) NOT NULL,
    title text NOT NULL,
    content text DEFAULT ''::text NOT NULL,
    search_text tsvector,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    due_at timestamp with time zone,
    assigned_to text,
    priority text,
    created_by text,
    last_edited_by text
);

CREATE TABLE public.embeddings (
    id text NOT NULL,
    node_id text NOT NULL,
    model_id text NOT NULL,
    vector public.vector(768) NOT NULL,
    content_hash text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    chunk_index integer DEFAULT 0 NOT NULL,
    chunk_start integer,
    chunk_end integer
);

CREATE TABLE public.feature_flags (
    id text NOT NULL,
    name text NOT NULL,
    enabled boolean DEFAULT false NOT NULL
);

CREATE TABLE public.file_embeddings (
    id text NOT NULL,
    content_hash text NOT NULL,
    model_id text NOT NULL,
    vector public.vector(768) NOT NULL,
    chunk_index integer DEFAULT 0 NOT NULL,
    chunk_start integer,
    chunk_end integer,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE public.files (
    id text NOT NULL,
    project_id text NOT NULL,
    relative_path text NOT NULL,
    content_hash text NOT NULL,
    size_bytes bigint DEFAULT 0 NOT NULL,
    search_text tsvector GENERATED ALWAYS AS ((to_tsvector('simple'::regconfig, COALESCE(relative_path, ''::text)) || to_tsvector('simple'::regconfig, translate(COALESCE(relative_path, ''::text), '/\.-_'::text, '     '::text)))) STORED
);

CREATE TABLE public.hook_registrations (
    id text NOT NULL,
    name text NOT NULL,
    source_path text NOT NULL,
    enabled boolean DEFAULT false NOT NULL,
    build_status text DEFAULT 'pending'::text NOT NULL,
    source_hash text,
    build_hash text,
    sdk_hash text,
    built_path text,
    last_error text,
    last_built_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    unattended_policy text DEFAULT 'skip'::text NOT NULL,
    run_as_agent_id text,
    run_as_build_hash text,
    CONSTRAINT hook_registrations_build_status_check CHECK ((build_status = ANY (ARRAY['pending'::text, 'building'::text, 'ready'::text, 'failed'::text, 'missing'::text]))),
    CONSTRAINT hook_registrations_run_as_build_chk CHECK (((run_as_agent_id IS NULL) OR (run_as_build_hash IS NOT NULL))),
    CONSTRAINT hook_registrations_run_as_not_ghost_chk CHECK ((run_as_agent_id IS DISTINCT FROM 'ghost'::text)),
    CONSTRAINT hook_registrations_unattended_policy_check CHECK ((unattended_policy = ANY (ARRAY['skip'::text, 'auto-approve-allowed'::text])))
);

COMMENT ON COLUMN public.hook_registrations.unattended_policy IS 'What a run this hook wakes does with a tool call that would ask: skip | auto-approve-allowed.';

COMMENT ON COLUMN public.hook_registrations.run_as_agent_id IS 'Agent the hook acts as (tool access + attribution). NULL: the event''s agent, else the ghost system actor.';

COMMENT ON COLUMN public.hook_registrations.run_as_build_hash IS 'build_hash run_as_agent_id was set for; a new source or build clears run as.';

CREATE TABLE public.hook_runs (
    id text NOT NULL,
    hook_name text NOT NULL,
    source text NOT NULL,
    event_name text NOT NULL,
    status text DEFAULT 'running'::text NOT NULL,
    agent_id text,
    thread_id text,
    duration_ms integer,
    exit_code integer,
    stdout text,
    stderr text,
    started_at timestamp with time zone DEFAULT now() NOT NULL,
    finished_at timestamp with time zone,
    chain_depth integer DEFAULT 0 NOT NULL,
    CONSTRAINT hook_runs_chain_depth_chk CHECK ((chain_depth >= 0)),
    CONSTRAINT hook_runs_source_check CHECK ((source = ANY (ARRAY['event'::text, 'manual'::text, 'schedule'::text, 'hook'::text, 'signal'::text, 'test'::text]))),
    CONSTRAINT hook_runs_status_check CHECK ((status = ANY (ARRAY['running'::text, 'succeeded'::text, 'failed'::text, 'timed_out'::text])))
);

CREATE TABLE public.images (
    id text DEFAULT ('image-'::text || gen_random_uuid()) NOT NULL,
    url text NOT NULL,
    alt_text text,
    metadata jsonb DEFAULT '{}'::jsonb NOT NULL,
    description text,
    tags text[] DEFAULT '{}'::text[] NOT NULL
);

CREATE TABLE public.links (
    id text NOT NULL,
    source_id text NOT NULL,
    target_id text NOT NULL,
    relation text NOT NULL,
    metadata jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT links_relation_check CHECK ((relation = ANY (ARRAY['references'::text, 'summarizes'::text, 'context'::text])))
);

CREATE TABLE public.mcp_api_keys (
    id text DEFAULT (gen_random_uuid())::text NOT NULL,
    member_id text NOT NULL,
    name text NOT NULL,
    key_hash text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    last_used_at timestamp with time zone
);

CREATE TABLE public.mcp_servers (
    id text NOT NULL,
    provider_id text,
    name text NOT NULL,
    transport text DEFAULT 'stdio'::text NOT NULL,
    command text,
    args jsonb DEFAULT '[]'::jsonb NOT NULL,
    url text,
    headers jsonb DEFAULT '{}'::jsonb NOT NULL,
    env jsonb DEFAULT '{}'::jsonb NOT NULL,
    scope text DEFAULT 'shared'::text NOT NULL,
    enabled boolean DEFAULT true NOT NULL,
    autoload boolean DEFAULT false NOT NULL,
    requires_confirmation boolean DEFAULT true NOT NULL,
    source text DEFAULT 'user'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE public.members (
    id text DEFAULT (gen_random_uuid())::text NOT NULL,
    kind text NOT NULL,
    agent_id text,
    user_id text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT members_kind_check CHECK ((kind = ANY (ARRAY['agent'::text, 'user'::text, 'external'::text]))),
    CONSTRAINT members_principal_match CHECK ((((kind = 'agent'::text) AND (agent_id IS NOT NULL) AND (user_id IS NULL)) OR ((kind = 'user'::text) AND (user_id IS NOT NULL) AND (agent_id IS NULL)) OR ((kind = 'external'::text) AND (agent_id IS NULL) AND (user_id IS NULL))))
);

CREATE TABLE public.memories (
    id text DEFAULT ('memory-'::text || (gen_random_uuid())::text) NOT NULL,
    agent_id text,
    memory_key text,
    content text NOT NULL,
    source_thread_id text,
    search_text tsvector GENERATED ALWAYS AS ((setweight(to_tsvector('english'::regconfig, COALESCE(memory_key, ''::text)), 'A'::"char") || setweight(to_tsvector('english'::regconfig, COALESCE(content, ''::text)), 'B'::"char"))) STORED,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    member_id text,
    verified boolean DEFAULT false NOT NULL,
    status text DEFAULT 'active'::text NOT NULL,
    CONSTRAINT memories_owner_xor_chk CHECK (((agent_id IS NOT NULL) <> (member_id IS NOT NULL))),
    CONSTRAINT memories_status_chk CHECK ((status = ANY (ARRAY['active'::text, 'proposed'::text])))
);

CREATE TABLE public.messages (
    id text DEFAULT ('message-'::text || (gen_random_uuid())::text) NOT NULL,
    thread_id text NOT NULL,
    user_id text,
    agent_id text,
    role text NOT NULL,
    content text NOT NULL,
    message_type text DEFAULT 'message'::text NOT NULL,
    resolved boolean DEFAULT false NOT NULL,
    metadata jsonb DEFAULT '{}'::jsonb NOT NULL,
    run_id text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    external_sender text,
    search_entity_terms text DEFAULT ''::text NOT NULL,
    search_text tsvector GENERATED ALWAYS AS (to_tsvector('english'::regconfig, ((COALESCE(content, ''::text) || ' '::text) || COALESCE(search_entity_terms, ''::text)))) STORED,
    visible_to_agent_id text,
    CONSTRAINT messages_at_most_one_author CHECK (((user_id IS NULL) OR (agent_id IS NULL))),
    CONSTRAINT messages_role_check CHECK ((role = ANY (ARRAY['user'::text, 'assistant'::text]))),
    CONSTRAINT messages_role_matches_author CHECK ((((user_id IS NULL) AND (agent_id IS NULL)) OR ((role = 'user'::text) AND (user_id IS NOT NULL)) OR ((role = 'assistant'::text) AND (agent_id IS NOT NULL)))),
    CONSTRAINT messages_type_check CHECK ((message_type = ANY (ARRAY['message'::text, 'question'::text, 'thread_event'::text])))
);

COMMENT ON COLUMN public.messages.external_sender IS 'Raw label for an unresolved from-sender (see resolveFromSender.ts). NULL when the message resolved to a real agent/user, or when no `from` was supplied.';

COMMENT ON COLUMN public.messages.visible_to_agent_id IS 'Agent-private message target. NULL = visible to everyone (default; all existing and normal messages). Non-null = rendered into the payload only when perceivingAgentId = visible_to_agent_id, skipped for every other participant. Used for persisted, agent-private workspace-watcher change messages.';

CREATE TABLE public.models (
    id text NOT NULL,
    provider_id text NOT NULL,
    model_id text NOT NULL,
    display_name text NOT NULL,
    description text DEFAULT ''::text NOT NULL,
    context_window_tokens integer,
    is_active boolean DEFAULT true NOT NULL,
    sort_order integer DEFAULT 0 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    family text,
    max_output_tokens integer,
    supports_tools boolean DEFAULT true NOT NULL,
    supports_vision boolean DEFAULT false NOT NULL,
    supports_reasoning boolean DEFAULT false NOT NULL,
    dimensions integer,
    metadata jsonb DEFAULT '{}'::jsonb,
    type character varying(20) DEFAULT 'llm'::character varying
);

CREATE TABLE public.nodes (
    id text NOT NULL,
    type public.node_type NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    archived boolean DEFAULT false NOT NULL,
    archived_at timestamp with time zone,
    container_id text,
    sort_order integer DEFAULT 0 NOT NULL,
    project_id text,
    CONSTRAINT nodes_archived_consistency_chk CHECK ((((archived = false) AND (archived_at IS NULL)) OR ((archived = true) AND (archived_at IS NOT NULL)))),
    CONSTRAINT nodes_thread_no_container_chk CHECK (((type <> 'thread'::public.node_type) OR (container_id IS NULL)))
);

COMMENT ON COLUMN public.nodes.sort_order IS 'Manual position among siblings, ascending. Docs, containers, images and sketches order within their container_id bucket; threads within their project_id bucket (NULL = flat), where a new thread takes slot 0 and last activity only breaks ties. A drop at slot N shifts live siblings at N or later down by one; archived rows are never rewritten (archived_node_immutable_guard).';

COMMENT ON COLUMN public.nodes.project_id IS 'Project scope: the id of a container with containers.category = ''project''. Only thread nodes carry it (trg_nodes_project_scope_guard); NULL = flat, workspace-level thread. Replaces container_id for threads, which never have one (nodes_thread_no_container_chk).';

CREATE TABLE public.notifications (
    id text NOT NULL,
    type text NOT NULL,
    title text NOT NULL,
    body text,
    thread_id text,
    agent_id text,
    run_id text,
    read boolean DEFAULT false NOT NULL,
    dismissed boolean DEFAULT false NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT notifications_type_check CHECK ((type = ANY (ARRAY['run_completed'::text, 'run_failed'::text, 'mention'::text, 'tool_approval'::text, 'thread_activity'::text, 'app_update'::text, 'automation'::text])))
);

CREATE TABLE public.placement_events (
    id text NOT NULL,
    node_id text NOT NULL,
    from_container_id text,
    to_container_id text,
    moved_by text,
    moved_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE public.provider_auth_types (
    id text NOT NULL,
    provider_id text NOT NULL,
    name text NOT NULL,
    type text NOT NULL,
    description text DEFAULT ''::text NOT NULL,
    token_label text,
    token_placeholder text,
    token_help text,
    sort_order integer DEFAULT 0 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    auth_header text
);

CREATE TABLE public.provider_fallback_credentials (
    id text DEFAULT (gen_random_uuid())::text NOT NULL,
    provider_id text NOT NULL,
    credential_id text NOT NULL,
    fallback_index integer NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE public.providers (
    id text NOT NULL,
    name text NOT NULL,
    description text DEFAULT ''::text NOT NULL,
    website text,
    api_docs text,
    sort_order integer DEFAULT 0 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    primary_credential_id text,
    default_metadata jsonb DEFAULT '{}'::jsonb NOT NULL,
    base_url text,
    type text DEFAULT 'llm'::text NOT NULL,
    enabled boolean DEFAULT true NOT NULL
);

CREATE TABLE public.reminder_deliveries (
    key text NOT NULL,
    delivered_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT reminder_deliveries_key_check CHECK (((char_length(key) >= 1) AND (char_length(key) <= 512)))
);

COMMENT ON TABLE public.reminder_deliveries IS 'Delivery ledger: one row per fired reminder key, so each reminder fires once. Pruned after 30 days.';

CREATE TABLE public.reminder_settings (
    kind text NOT NULL,
    event_id text,
    table_id text,
    entry_id uuid,
    field_id text,
    automation_id text,
    item_key text GENERATED ALWAYS AS (
CASE kind
    WHEN 'event'::text THEN ('event:'::text || event_id)
    WHEN 'table_entry'::text THEN ((((('table_entry:'::text || table_id) || ':'::text) || (entry_id)::text) || ':'::text) || field_id)
    WHEN 'automation'::text THEN ('automation:'::text || automation_id)
    ELSE NULL::text
END) STORED NOT NULL,
    enabled boolean DEFAULT true NOT NULL,
    at_start boolean DEFAULT true NOT NULL,
    offsets jsonb DEFAULT '[]'::jsonb NOT NULL,
    sound text DEFAULT 'chime'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT reminder_settings_item_shape_check CHECK ((((kind = 'event'::text) AND (event_id IS NOT NULL) AND (table_id IS NULL) AND (entry_id IS NULL) AND (field_id IS NULL) AND (automation_id IS NULL)) OR ((kind = 'table_entry'::text) AND (table_id IS NOT NULL) AND (entry_id IS NOT NULL) AND (field_id IS NOT NULL) AND (event_id IS NULL) AND (automation_id IS NULL)) OR ((kind = 'automation'::text) AND (automation_id IS NOT NULL) AND (event_id IS NULL) AND (table_id IS NULL) AND (entry_id IS NULL) AND (field_id IS NULL)))),
    CONSTRAINT reminder_settings_kind_check CHECK ((kind = ANY (ARRAY['event'::text, 'table_entry'::text, 'automation'::text]))),
    CONSTRAINT reminder_settings_offsets_check CHECK (((jsonb_typeof(offsets) = 'array'::text) AND (jsonb_array_length(offsets) <= 10))),
    CONSTRAINT reminder_settings_sound_check CHECK (((char_length(sound) >= 1) AND (char_length(sound) <= 32)))
);

COMMENT ON TABLE public.reminder_settings IS 'Per-item reminder settings for calendar items with a start time (events, timed table-row dates, automations).';

CREATE TABLE public.runs (
    id text NOT NULL,
    thread_id text,
    agent_id text,
    provider_id text NOT NULL,
    model text NOT NULL,
    status text NOT NULL,
    error text,
    started_at timestamp with time zone NOT NULL,
    finished_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    input_tokens integer,
    output_tokens integer,
    cache_read_tokens integer,
    cache_creation_tokens integer,
    provider_calls integer
);

COMMENT ON COLUMN public.runs.cache_read_tokens IS 'Prompt-cache tokens served from cache across the run. NULL = never recorded; 0 = recorded, provider reported no cache read. Reported by the Anthropic, Gemini and OpenAI-style chat-completions adapters.';

COMMENT ON COLUMN public.runs.cache_creation_tokens IS 'Prompt-cache tokens written to cache across the run. Same NULL/0 distinction as cache_read_tokens. Reported by the Anthropic adapter only.';

COMMENT ON COLUMN public.runs.provider_calls IS 'Number of provider round-trips in the run. Divides run totals into per-call averages and distinguishes one expensive call from many cheap ones.';

CREATE TABLE public.schedule_runs (
    id text NOT NULL,
    schedule_id text NOT NULL,
    scheduled_for timestamp with time zone NOT NULL,
    status text NOT NULL,
    output text,
    error text,
    started_at timestamp with time zone DEFAULT now() NOT NULL,
    finished_at timestamp with time zone,
    manual boolean DEFAULT false NOT NULL,
    CONSTRAINT schedule_runs_status_check CHECK ((status = ANY (ARRAY['running'::text, 'succeeded'::text, 'failed'::text, 'skipped'::text])))
);

COMMENT ON COLUMN public.schedule_runs.manual IS 'A Run now (a person or an agent pressed it), not a scheduled run; set when the run is claimed.';

CREATE TABLE public.schedules (
    id text NOT NULL,
    name text NOT NULL,
    enabled boolean DEFAULT true NOT NULL,
    schedule_kind text NOT NULL,
    schedule_json jsonb DEFAULT '{}'::jsonb NOT NULL,
    timezone text DEFAULT 'UTC'::text NOT NULL,
    action_kind text NOT NULL,
    action_json jsonb DEFAULT '{}'::jsonb NOT NULL,
    next_run_at timestamp with time zone,
    last_run_at timestamp with time zone,
    last_status text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT schedules_action_kind_check CHECK ((action_kind = ANY (ARRAY['hook'::text, 'automation'::text]))),
    CONSTRAINT schedules_schedule_kind_check CHECK ((schedule_kind = ANY (ARRAY['once'::text, 'interval'::text, 'calendar'::text, 'rrule'::text, 'first_open'::text])))
);

CREATE TABLE public.settings (
    category text NOT NULL,
    key text NOT NULL,
    value jsonb NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_by_user_id text,
    updated_by_agent_id text,
    CONSTRAINT settings_at_most_one_author CHECK (((updated_by_user_id IS NULL) OR (updated_by_agent_id IS NULL))),
    CONSTRAINT settings_category_format CHECK ((category ~ '^[a-z][a-z0-9_]*$'::text)),
    CONSTRAINT settings_key_format CHECK ((key ~ '^[a-z][a-z0-9_]*(\.[a-z0-9_]+)*$'::text))
);

CREATE TABLE public.skill_registry (
    id text NOT NULL,
    scope text NOT NULL,
    project_id text,
    slug text NOT NULL,
    name text DEFAULT ''::text NOT NULL,
    description text DEFAULT ''::text NOT NULL,
    source_path text NOT NULL,
    content_hash text,
    status text DEFAULT 'valid'::text NOT NULL,
    error text,
    indexed_at timestamp with time zone DEFAULT now() NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT skill_registry_scope_check CHECK ((scope = ANY (ARRAY['personal'::text, 'project'::text, 'builtin'::text]))),
    CONSTRAINT skill_registry_scope_project_chk CHECK ((((scope = ANY (ARRAY['personal'::text, 'builtin'::text])) AND (project_id IS NULL)) OR ((scope = 'project'::text) AND (project_id IS NOT NULL)))),
    CONSTRAINT skill_registry_slug_check CHECK ((slug ~ '^[a-z0-9][a-z0-9._-]{0,63}$'::text)),
    CONSTRAINT skill_registry_status_check CHECK ((status = ANY (ARRAY['valid'::text, 'invalid'::text, 'missing'::text])))
);

COMMENT ON TABLE public.skill_registry IS 'Discovery index of SKILL.md folders (~/.snaglet/skills, <project>/.snaglet/skills). Disk is the source of truth.';

CREATE TABLE public.socket_sessions (
    id text NOT NULL,
    agent_id text NOT NULL,
    thread_id text NOT NULL,
    participant_agent_ids text[] DEFAULT '{}'::text[] NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE public.subagents (
    id text DEFAULT ('subagent-'::text || (gen_random_uuid())::text) NOT NULL,
    parent_thread_id text NOT NULL,
    orchestrator_agent_id text NOT NULL,
    agent_id text NOT NULL,
    thread_id text,
    started_by_run_id text,
    name text NOT NULL,
    provider_id text NOT NULL,
    model_id text NOT NULL,
    status text DEFAULT 'running'::text NOT NULL,
    error text,
    last_result_message_id text,
    last_reply_message_id text,
    delivered_run_id text,
    task_count integer DEFAULT 1 NOT NULL,
    last_task_at timestamp with time zone DEFAULT now() NOT NULL,
    finished_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    deleted_at timestamp with time zone,
    resume_at timestamp with time zone,
    CONSTRAINT subagents_finished_at_chk CHECK (((status = 'running'::text) = (finished_at IS NULL))),
    CONSTRAINT subagents_name_check CHECK (((btrim(name) <> ''::text) AND (char_length(name) <= 60))),
    CONSTRAINT subagents_not_own_orchestrator_chk CHECK ((agent_id <> orchestrator_agent_id)),
    CONSTRAINT subagents_resume_at_chk CHECK (((resume_at IS NULL) OR (status = 'stopped'::text))),
    CONSTRAINT subagents_status_check CHECK ((status = ANY (ARRAY['running'::text, 'finished'::text, 'failed'::text, 'stopped'::text]))),
    CONSTRAINT subagents_task_count_check CHECK ((task_count >= 1))
);

CREATE TABLE public.table_catalog (
    id text NOT NULL,
    name text NOT NULL,
    table_name text NOT NULL,
    origin text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    state text DEFAULT 'active'::text NOT NULL,
    state_changed_at timestamp with time zone,
    held_by text,
    project_id text,
    sort_order integer DEFAULT 0 NOT NULL,
    CONSTRAINT table_catalog_builtin_active_check CHECK (((origin = 'custom'::text) OR (state = 'active'::text))),
    CONSTRAINT table_catalog_builtin_no_project_chk CHECK (((origin <> 'builtin'::text) OR (project_id IS NULL))),
    CONSTRAINT table_catalog_custom_name_is_table CHECK (((origin <> 'custom'::text) OR (state <> 'active'::text) OR (name = table_name))),
    CONSTRAINT table_catalog_held_check CHECK (((state = 'deleted'::text) = (held_by IS NOT NULL))),
    CONSTRAINT table_catalog_id_origin_check CHECK (((origin = 'builtin'::text) = starts_with(id, 'table-builtin-'::text))),
    CONSTRAINT table_catalog_origin_check CHECK ((origin = ANY (ARRAY['builtin'::text, 'custom'::text]))),
    CONSTRAINT table_catalog_retired_table_name_check CHECK (((state = 'active'::text) OR (table_name ~ '^_snaglet_[a-z0-9_]{1,54}$'::text))),
    CONSTRAINT table_catalog_state_check CHECK ((state = ANY (ARRAY['active'::text, 'archived'::text, 'deleted'::text]))),
    CONSTRAINT table_catalog_table_name_check CHECK ((table_name ~ '^[a-z_][a-z0-9_]{0,62}$'::text))
);

COMMENT ON COLUMN public.table_catalog.project_id IS 'Optional project home: the id of a container with containers.category = ''project'' (trg_table_catalog_project_scope_guard). NULL = workspace-wide. Built-in tables never carry one.';

COMMENT ON COLUMN public.table_catalog.sort_order IS 'Manual position of a custom table within its project_id bucket (NULL = workspace-wide), ascending; a new table or one moved without a slot lands at the bottom. Built-in tables are not reorderable: they keep 0 and list first, by name.';

CREATE TABLE public.table_entry_embeddings (
    table_id text NOT NULL,
    entry_id uuid NOT NULL,
    model_id text NOT NULL,
    card_hash text NOT NULL,
    vector public.vector(768) NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE public.table_entry_occurrences (
    id text DEFAULT ('tocc-'::text || (gen_random_uuid())::text) NOT NULL,
    table_id text NOT NULL,
    field_id text NOT NULL,
    entry_id uuid NOT NULL,
    occurrence text NOT NULL,
    kind text NOT NULL,
    moved_to text,
    actor_kind text,
    actor_id text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT table_entry_occurrences_kind_check CHECK ((kind = ANY (ARRAY['done'::text, 'skipped'::text, 'moved'::text]))),
    CONSTRAINT table_entry_occurrences_moved_to_check CHECK ((((kind = 'moved'::text) AND (moved_to IS NOT NULL) AND (moved_to ~ '^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}:\d{2})?$'::text)) OR ((kind <> 'moved'::text) AND (moved_to IS NULL)))),
    CONSTRAINT table_entry_occurrences_occurrence_check CHECK ((occurrence ~ '^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}:\d{2})?$'::text))
);

CREATE TABLE public.table_entry_repeats (
    table_id text NOT NULL,
    field_id text NOT NULL,
    entry_id uuid NOT NULL,
    value jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT table_entry_repeats_value_check CHECK ((jsonb_typeof(value) = 'object'::text))
);

CREATE TABLE public.table_fields (
    id text NOT NULL,
    table_id text NOT NULL,
    column_name text NOT NULL,
    name text NOT NULL,
    description text,
    type text NOT NULL,
    nullable boolean NOT NULL,
    default_value jsonb DEFAULT 'null'::jsonb NOT NULL,
    default_expression text,
    reference_table_id text,
    "position" integer NOT NULL,
    managed boolean DEFAULT false NOT NULL,
    revision integer DEFAULT 1 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    collapsed boolean DEFAULT false NOT NULL,
    is_title boolean DEFAULT false NOT NULL,
    multiple boolean DEFAULT false NOT NULL,
    options jsonb,
    state text DEFAULT 'active'::text NOT NULL,
    state_changed_at timestamp with time zone,
    held_by text,
    reference_kind text,
    recurrence jsonb,
    calendar_id text,
    is_range boolean DEFAULT false NOT NULL,
    width integer,
    CONSTRAINT table_fields_calendar_check CHECK (((calendar_id IS NULL) OR (type = ANY (ARRAY['date'::text, 'datetime'::text])))),
    CONSTRAINT table_fields_column_name_check CHECK ((column_name ~ '^[a-z_][a-z0-9_]{0,62}$'::text)),
    CONSTRAINT table_fields_default_check CHECK (((default_value = 'null'::jsonb) OR ((type = ANY (ARRAY['text'::text, 'number'::text, 'date'::text, 'datetime'::text])) AND (jsonb_typeof(default_value) = 'string'::text)) OR ((type = 'checkbox'::text) AND (jsonb_typeof(default_value) = 'boolean'::text)) OR ((type = 'relation'::text) AND multiple AND (default_value = '[]'::jsonb)) OR ((type = 'select'::text) AND (NOT multiple) AND (jsonb_typeof(default_value) = 'string'::text)) OR ((type = 'select'::text) AND multiple AND (jsonb_typeof(default_value) = 'array'::text)))),
    CONSTRAINT table_fields_description_check CHECK ((length(description) <= 2000)),
    CONSTRAINT table_fields_held_check CHECK (((state = 'deleted'::text) = (held_by IS NOT NULL))),
    CONSTRAINT table_fields_managed_check CHECK (((managed AND (((column_name = 'id'::text) AND (type = 'uuid'::text)) OR ((column_name = 'created_at'::text) AND (type = 'datetime'::text)))) OR ((NOT managed) AND (type = ANY (ARRAY['text'::text, 'number'::text, 'date'::text, 'datetime'::text, 'checkbox'::text, 'relation'::text, 'select'::text])) AND (((state = 'active'::text) AND (column_name ~ '^[a-z][a-z0-9_]{0,62}$'::text) AND (column_name <> ALL (ARRAY['id'::text, 'created_at'::text, 'position'::text]))) OR ((state <> 'active'::text) AND (column_name ~ '^_snaglet_[a-z0-9_]{1,54}$'::text)))))),
    CONSTRAINT table_fields_multiple_check CHECK (((NOT multiple) OR (type = ANY (ARRAY['relation'::text, 'select'::text])))),
    CONSTRAINT table_fields_name_check CHECK (((length(name) >= 1) AND (length(name) <= 63))),
    CONSTRAINT table_fields_name_is_column CHECK (((state <> 'active'::text) OR (name = column_name))),
    CONSTRAINT table_fields_options_check CHECK ((((type = 'select'::text) AND (options IS NOT NULL) AND (jsonb_typeof(options) = 'array'::text) AND ((NOT multiple) OR ((NOT nullable) AND (jsonb_typeof(default_value) = 'array'::text)))) OR ((type <> 'select'::text) AND (options IS NULL)))),
    CONSTRAINT table_fields_position_check CHECK (("position" >= 0)),
    CONSTRAINT table_fields_range_check CHECK (((NOT is_range) OR (type = ANY (ARRAY['date'::text, 'datetime'::text])))),
    CONSTRAINT table_fields_range_default_check CHECK (((NOT is_range) OR (default_value = 'null'::jsonb))),
    CONSTRAINT table_fields_recurrence_check CHECK (((recurrence IS NULL) OR ((type = ANY (ARRAY['date'::text, 'datetime'::text])) AND (NOT managed) AND (jsonb_typeof(recurrence) = 'object'::text)))),
    CONSTRAINT table_fields_reference_check CHECK ((((type = 'relation'::text) AND (num_nonnulls(reference_table_id, reference_kind) <= 1) AND ((num_nonnulls(reference_table_id, reference_kind) = 1) OR (state <> 'active'::text)) AND (((NOT multiple) AND nullable AND (default_value = 'null'::jsonb)) OR (multiple AND (NOT nullable) AND (default_value = '[]'::jsonb)))) OR ((type <> 'relation'::text) AND (reference_table_id IS NULL) AND (reference_kind IS NULL)))),
    CONSTRAINT table_fields_reference_kind_check CHECK (((reference_kind IS NULL) OR (reference_kind = ANY (ARRAY['doc'::text, 'project'::text, 'container'::text, 'thread'::text, 'image'::text, 'agent'::text, 'member'::text])))),
    CONSTRAINT table_fields_revision_check CHECK ((revision > 0)),
    CONSTRAINT table_fields_state_check CHECK ((state = ANY (ARRAY['active'::text, 'archived'::text, 'deleted'::text]))),
    CONSTRAINT table_fields_state_managed_check CHECK (((state = 'active'::text) OR (NOT managed))),
    CONSTRAINT table_fields_title_check CHECK (((NOT is_title) OR ((type = 'text'::text) AND (NOT managed)))),
    CONSTRAINT table_fields_type_check CHECK ((type = ANY (ARRAY['text'::text, 'number'::text, 'date'::text, 'datetime'::text, 'checkbox'::text, 'relation'::text, 'select'::text, 'uuid'::text]))),
    CONSTRAINT table_fields_width_check CHECK (((width IS NULL) OR ((width >= 64) AND (width <= 800))))
);

COMMENT ON COLUMN public.table_fields.calendar_id IS 'Calendar this date/datetime field shows on; every row''s value shows there. NULL = not on a calendar.';

COMMENT ON COLUMN public.table_fields.is_range IS 'Date/datetime field holding a start and an end: a daterange (end day included on the wire) or tstzrange column.';

COMMENT ON COLUMN public.table_fields.width IS 'Grid column width in CSS px (64-800); NULL = auto. A view preference: no revision, not schema.';

CREATE TABLE public.table_history (
    id text NOT NULL,
    actor_kind text NOT NULL,
    actor_id text NOT NULL,
    actor_name text,
    seq bigint NOT NULL,
    state text NOT NULL,
    kind text NOT NULL,
    label text NOT NULL,
    table_ids text[] DEFAULT '{}'::text[] NOT NULL,
    ops jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT table_history_actor_id_check CHECK (((length(actor_id) >= 1) AND (length(actor_id) <= 200))),
    CONSTRAINT table_history_actor_kind_check CHECK ((actor_kind = ANY (ARRAY['user'::text, 'agent'::text, 'external'::text, 'system'::text]))),
    CONSTRAINT table_history_ops_check CHECK ((jsonb_typeof(ops) = 'array'::text)),
    CONSTRAINT table_history_seq_check CHECK ((seq > 0)),
    CONSTRAINT table_history_state_check CHECK ((state = ANY (ARRAY['done'::text, 'undone'::text])))
);

CREATE TABLE public.table_semantic_search (
    table_id text NOT NULL,
    enabled_at timestamp with time zone DEFAULT now() NOT NULL,
    confirmed_rows integer,
    CONSTRAINT table_semantic_search_confirmed_rows_check CHECK (((confirmed_rows IS NULL) OR (confirmed_rows > 0)))
);

CREATE TABLE public.thread_notification_settings (
    thread_id text NOT NULL,
    enabled boolean DEFAULT false NOT NULL,
    sound text DEFAULT 'chime'::text NOT NULL,
    on_completed boolean DEFAULT true NOT NULL,
    on_failed boolean DEFAULT true NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT thread_notification_settings_sound_check CHECK (((char_length(sound) >= 1) AND (char_length(sound) <= 64)))
);

COMMENT ON TABLE public.thread_notification_settings IS 'Per-thread run-ended notification settings (opt-in; no row = off).';

COMMENT ON COLUMN public.thread_notification_settings.sound IS 'Sound id from REMINDER_SOUNDS (@snaglet/shared/types/reminders); validated by the server.';

CREATE TABLE public.thread_participants (
    id text DEFAULT (gen_random_uuid())::text NOT NULL,
    thread_id text NOT NULL,
    provider_id text,
    model_id text,
    credential_id text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    system_prompt_addendum text,
    auto_respond boolean DEFAULT true NOT NULL,
    tool_access_mode text,
    tool_access_allow_list jsonb,
    tool_access_deny_list jsonb,
    tool_overrides jsonb,
    member_id text NOT NULL,
    disable_model_fallback boolean DEFAULT false NOT NULL,
    max_tool_calls_per_turn integer,
    max_duration_seconds integer,
    skill_mode text DEFAULT 'inherit'::text NOT NULL,
    last_read_at timestamp with time zone,
    CONSTRAINT thread_participants_skill_mode_chk CHECK ((skill_mode = ANY (ARRAY['inherit'::text, 'add'::text, 'override'::text])))
);

COMMENT ON COLUMN public.thread_participants.system_prompt_addendum IS 'Optional prompt fragment appended only when THIS agent runs in THIS thread. Applied after threads.thread_system_prompt. NULL = no per-agent addendum.';

COMMENT ON COLUMN public.thread_participants.auto_respond IS 'When FALSE, this agent only wakes on explicit @mention regardless of the thread''s dispatch_mode. Lets a thread mix broadcast-style and on-demand participants. Default TRUE preserves prior behavior.';

COMMENT ON COLUMN public.thread_participants.skill_mode IS 'How this agent''s skills combine in THIS thread: inherit (general defaults), add (defaults + thread picks), override (thread picks only; empty = none).';

CREATE TABLE public.thread_summaries (
    id text DEFAULT ('summary-'::text || (gen_random_uuid())::text) NOT NULL,
    thread_id text NOT NULL,
    agent_id text,
    summary_text text NOT NULL,
    messages_covered integer DEFAULT 0 NOT NULL,
    last_message_id text,
    model_used text,
    version integer DEFAULT 1 NOT NULL,
    is_current boolean DEFAULT false NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    search_text tsvector GENERATED ALWAYS AS (to_tsvector('english'::regconfig, COALESCE(summary_text, ''::text))) STORED,
    compaction jsonb
);

COMMENT ON COLUMN public.thread_summaries.compaction IS 'Set on a fold: {through, folded_units, carry_forward}. NULL on a digest.';

CREATE TABLE public.threads (
    id text DEFAULT ('thread-'::text || (gen_random_uuid())::text) NOT NULL,
    title text,
    last_message_at timestamp with time zone,
    dispatch_mode text DEFAULT 'mentioned'::text NOT NULL,
    thread_system_prompt text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    max_waves integer,
    max_total_output_tokens integer,
    max_agent_dispatches integer,
    tool_access_mode text,
    tool_access_allow_list jsonb,
    tool_access_deny_list jsonb,
    parent_thread_id text,
    working_directory text,
    kind text DEFAULT 'chat'::text NOT NULL,
    dm_pair_key text,
    CONSTRAINT threads_dispatch_mode_check CHECK ((dispatch_mode = ANY (ARRAY['all'::text, 'mentioned'::text]))),
    CONSTRAINT threads_dm_pair_key_chk CHECK (((kind = 'dm'::text) = (dm_pair_key IS NOT NULL))),
    CONSTRAINT threads_kind_chk CHECK ((kind = ANY (ARRAY['chat'::text, 'dm'::text]))),
    CONSTRAINT threads_max_waves_check CHECK (((max_waves IS NULL) OR (max_waves = '-1'::integer) OR (max_waves > 0))),
    CONSTRAINT threads_parent_thread_not_self_chk CHECK (((parent_thread_id IS NULL) OR (parent_thread_id <> id))),
    CONSTRAINT threads_tool_access_mode_check CHECK (((tool_access_mode IS NULL) OR (tool_access_mode = ANY (ARRAY['all'::text, 'allow_list'::text, 'deny_list'::text]))))
);

COMMENT ON COLUMN public.threads.thread_system_prompt IS 'Optional prompt fragment appended to every participating agent''s system prompt while running in this thread. Applied after the agent base prompt and before any per-participant override. NULL = no thread-level addendum.';

CREATE TABLE public.tools (
    id text NOT NULL,
    name text NOT NULL,
    description text DEFAULT ''::text NOT NULL,
    type text NOT NULL,
    parameters_schema jsonb DEFAULT '{}'::jsonb NOT NULL,
    source text,
    config_json jsonb DEFAULT '{}'::jsonb NOT NULL,
    sort_order integer DEFAULT 0 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    tier text DEFAULT 'standard'::text NOT NULL,
    category_path text DEFAULT 'uncategorized'::text NOT NULL,
    provider_id text,
    keywords text[] DEFAULT '{}'::text[],
    aliases text[] DEFAULT '{}'::text[],
    enabled boolean DEFAULT true NOT NULL,
    search_text tsvector GENERATED ALWAYS AS ((((setweight(to_tsvector('simple'::regconfig, ((COALESCE(id, ''::text) || ' '::text) || COALESCE(name, ''::text))), 'A'::"char") || setweight(to_tsvector('simple'::regconfig, public.snaglet_text_array_to_string(aliases)), 'A'::"char")) || setweight(to_tsvector('simple'::regconfig, public.snaglet_text_array_to_string(keywords)), 'B'::"char")) || setweight(to_tsvector('english'::regconfig, COALESCE(description, ''::text)), 'C'::"char"))) STORED
);

CREATE TABLE public.user_provider_credentials (
    id text NOT NULL,
    provider_id text NOT NULL,
    auth_type text NOT NULL,
    label text NOT NULL,
    encrypted_secret text NOT NULL,
    metadata_json jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    auth_type_id text,
    verification_status text DEFAULT 'untested'::text NOT NULL,
    encrypted_bundle text
);

CREATE TABLE public.users (
    id text NOT NULL,
    email text NOT NULL,
    name text DEFAULT ''::text NOT NULL,
    picture text,
    auth_provider text DEFAULT 'google'::text NOT NULL,
    auth_provider_id text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    active boolean DEFAULT false NOT NULL
);

--
-- Primary keys, unique and check constraints
--

ALTER TABLE ONLY public.agent_activity_log
    ADD CONSTRAINT agent_activity_log_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.agent_skill_assignments
    ADD CONSTRAINT agent_skill_assignments_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.agents
    ADD CONSTRAINT agents_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.automations
    ADD CONSTRAINT automations_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.automations
    ADD CONSTRAINT automations_schedule_id_key UNIQUE (schedule_id);

ALTER TABLE ONLY public.calendar_events
    ADD CONSTRAINT calendar_events_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.calendars
    ADD CONSTRAINT calendars_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.containers
    ADD CONSTRAINT containers_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.doc_edit_state
    ADD CONSTRAINT doc_edit_state_pkey PRIMARY KEY (doc_id);

ALTER TABLE ONLY public.doc_snapshots
    ADD CONSTRAINT doc_snapshots_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.docs
    ADD CONSTRAINT docs_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.embeddings
    ADD CONSTRAINT embeddings_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.feature_flags
    ADD CONSTRAINT feature_flags_name_key UNIQUE (name);

ALTER TABLE ONLY public.feature_flags
    ADD CONSTRAINT feature_flags_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.file_embeddings
    ADD CONSTRAINT file_embeddings_content_hash_model_id_chunk_index_key UNIQUE (content_hash, model_id, chunk_index);

ALTER TABLE ONLY public.file_embeddings
    ADD CONSTRAINT file_embeddings_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.files
    ADD CONSTRAINT files_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.files
    ADD CONSTRAINT files_project_id_relative_path_key UNIQUE (project_id, relative_path);

ALTER TABLE ONLY public.hook_registrations
    ADD CONSTRAINT hook_registrations_name_key UNIQUE (name);

ALTER TABLE ONLY public.hook_registrations
    ADD CONSTRAINT hook_registrations_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.hook_runs
    ADD CONSTRAINT hook_runs_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.images
    ADD CONSTRAINT images_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.links
    ADD CONSTRAINT links_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.links
    ADD CONSTRAINT links_source_target_relation_unique UNIQUE (source_id, target_id, relation);

ALTER TABLE ONLY public.mcp_api_keys
    ADD CONSTRAINT mcp_api_keys_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.mcp_servers
    ADD CONSTRAINT mcp_servers_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.members
    ADD CONSTRAINT members_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.memories
    ADD CONSTRAINT memories_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.messages
    ADD CONSTRAINT messages_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.models
    ADD CONSTRAINT models_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.models
    ADD CONSTRAINT models_provider_id_model_id_key UNIQUE (provider_id, model_id);

ALTER TABLE ONLY public.nodes
    ADD CONSTRAINT nodes_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.notifications
    ADD CONSTRAINT notifications_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.placement_events
    ADD CONSTRAINT placement_events_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.provider_auth_types
    ADD CONSTRAINT provider_auth_types_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.provider_fallback_credentials
    ADD CONSTRAINT provider_fallback_credentials_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.provider_fallback_credentials
    ADD CONSTRAINT provider_fallback_credentials_provider_id_credential_id_key UNIQUE (provider_id, credential_id);

ALTER TABLE ONLY public.provider_fallback_credentials
    ADD CONSTRAINT provider_fallback_credentials_provider_id_fallback_index_key UNIQUE (provider_id, fallback_index);

ALTER TABLE ONLY public.providers
    ADD CONSTRAINT providers_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.reminder_deliveries
    ADD CONSTRAINT reminder_deliveries_pkey PRIMARY KEY (key);

ALTER TABLE ONLY public.reminder_settings
    ADD CONSTRAINT reminder_settings_pkey PRIMARY KEY (item_key);

ALTER TABLE ONLY public.runs
    ADD CONSTRAINT runs_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.schedule_runs
    ADD CONSTRAINT schedule_runs_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.schedule_runs
    ADD CONSTRAINT schedule_runs_schedule_id_scheduled_for_key UNIQUE (schedule_id, scheduled_for);

ALTER TABLE ONLY public.schedules
    ADD CONSTRAINT schedules_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.settings
    ADD CONSTRAINT settings_pkey PRIMARY KEY (category, key);

ALTER TABLE ONLY public.skill_registry
    ADD CONSTRAINT skill_registry_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.socket_sessions
    ADD CONSTRAINT socket_sessions_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.subagents
    ADD CONSTRAINT subagents_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.table_catalog
    ADD CONSTRAINT table_catalog_origin_table_name_key UNIQUE (origin, table_name);

ALTER TABLE ONLY public.table_catalog
    ADD CONSTRAINT table_catalog_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.table_entry_embeddings
    ADD CONSTRAINT table_entry_embeddings_pkey PRIMARY KEY (table_id, entry_id);

ALTER TABLE ONLY public.table_entry_occurrences
    ADD CONSTRAINT table_entry_occurrences_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.table_entry_repeats
    ADD CONSTRAINT table_entry_repeats_pkey PRIMARY KEY (field_id, entry_id);

ALTER TABLE ONLY public.table_fields
    ADD CONSTRAINT table_fields_column_key UNIQUE (table_id, column_name);

ALTER TABLE ONLY public.table_fields
    ADD CONSTRAINT table_fields_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.table_history
    ADD CONSTRAINT table_history_actor_seq_key UNIQUE (actor_kind, actor_id, seq);

ALTER TABLE ONLY public.table_history
    ADD CONSTRAINT table_history_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.table_semantic_search
    ADD CONSTRAINT table_semantic_search_pkey PRIMARY KEY (table_id);

ALTER TABLE ONLY public.thread_notification_settings
    ADD CONSTRAINT thread_notification_settings_pkey PRIMARY KEY (thread_id);

ALTER TABLE ONLY public.thread_participants
    ADD CONSTRAINT thread_participants_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.thread_summaries
    ADD CONSTRAINT thread_summaries_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.threads
    ADD CONSTRAINT threads_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.tools
    ADD CONSTRAINT tools_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.user_provider_credentials
    ADD CONSTRAINT user_provider_credentials_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.users
    ADD CONSTRAINT users_auth_provider_id_unique UNIQUE (auth_provider, auth_provider_id);

ALTER TABLE ONLY public.users
    ADD CONSTRAINT users_pkey PRIMARY KEY (id);

--
-- Indexes
--

CREATE UNIQUE INDEX agent_skill_assignments_general_uq ON public.agent_skill_assignments USING btree (agent_id, skill_id) WHERE (thread_id IS NULL);

CREATE INDEX agent_skill_assignments_skill_idx ON public.agent_skill_assignments USING btree (skill_id);

CREATE UNIQUE INDEX agent_skill_assignments_thread_uq ON public.agent_skill_assignments USING btree (agent_id, thread_id, skill_id) WHERE (thread_id IS NOT NULL);

CREATE UNIQUE INDEX agents_name_lower_key ON public.agents USING btree (lower(name)) WHERE (parent_agent_id IS NULL);

CREATE INDEX agents_parent_agent_idx ON public.agents USING btree (parent_agent_id) WHERE (parent_agent_id IS NOT NULL);

CREATE INDEX automations_agent_active_idx ON public.automations USING btree (agent_id) WHERE (status = 'active'::text);

CREATE INDEX automations_calendar_idx ON public.automations USING btree (calendar_id) WHERE (status <> 'cancelled'::text);

CREATE UNIQUE INDEX calendar_events_date_exception_idx ON public.calendar_events USING btree (recurring_event_id, original_start_date) WHERE ((recurring_event_id IS NOT NULL) AND (original_start_date IS NOT NULL));

CREATE INDEX calendar_events_date_window_idx ON public.calendar_events USING btree (calendar_id, start_date, end_date) WHERE (time_kind = 'all_day'::text);

CREATE INDEX calendar_events_parent_idx ON public.calendar_events USING btree (recurring_event_id) WHERE (recurring_event_id IS NOT NULL);

CREATE UNIQUE INDEX calendar_events_root_uid_idx ON public.calendar_events USING btree (calendar_id, ical_uid) WHERE (recurring_event_id IS NULL);

CREATE INDEX calendar_events_series_idx ON public.calendar_events USING btree (calendar_id) WHERE (cardinality(recurrence) > 0);

CREATE UNIQUE INDEX calendar_events_timed_exception_idx ON public.calendar_events USING btree (recurring_event_id, original_start_at) WHERE ((recurring_event_id IS NOT NULL) AND (original_start_at IS NOT NULL));

CREATE INDEX calendar_events_timed_window_idx ON public.calendar_events USING btree (calendar_id, start_at, end_at) WHERE (time_kind = 'timed'::text);

CREATE UNIQUE INDEX calendars_one_default_key ON public.calendars USING btree ((true)) WHERE is_default;

CREATE INDEX containers_created_at_idx ON public.containers USING btree (created_at DESC);

CREATE INDEX doc_snapshots_doc_id_created_at_idx ON public.doc_snapshots USING btree (doc_id, created_at DESC);

CREATE INDEX doc_snapshots_label_idx ON public.doc_snapshots USING btree (label) WHERE (label IS NOT NULL);

CREATE INDEX docs_created_at_idx ON public.docs USING btree (created_at DESC);

CREATE INDEX docs_search_text_idx ON public.docs USING gin (search_text);

CREATE INDEX embeddings_model_idx ON public.embeddings USING btree (model_id);

CREATE UNIQUE INDEX embeddings_node_model_hash_chunk_idx ON public.embeddings USING btree (node_id, model_id, content_hash, chunk_index);

CREATE INDEX embeddings_vector_hnsw_idx ON public.embeddings USING hnsw (vector public.vector_cosine_ops);

CREATE INDEX file_embeddings_model_idx ON public.file_embeddings USING btree (model_id);

CREATE INDEX file_embeddings_vector_hnsw_idx ON public.file_embeddings USING hnsw (vector public.vector_cosine_ops);

CREATE INDEX files_content_hash_idx ON public.files USING btree (content_hash);

CREATE INDEX files_search_text_idx ON public.files USING gin (search_text);

CREATE INDEX hook_registrations_enabled_ready_idx ON public.hook_registrations USING btree (enabled, build_status);

CREATE INDEX hook_registrations_run_as_idx ON public.hook_registrations USING btree (run_as_agent_id) WHERE (run_as_agent_id IS NOT NULL);

CREATE INDEX hook_runs_hook_started_idx ON public.hook_runs USING btree (hook_name, started_at DESC);

CREATE INDEX hook_runs_started_idx ON public.hook_runs USING btree (started_at DESC);

CREATE INDEX idx_activity_log_action ON public.agent_activity_log USING btree (agent_id, action_type, created_at DESC);

CREATE INDEX idx_activity_log_agent ON public.agent_activity_log USING btree (agent_id, created_at DESC);

CREATE INDEX idx_activity_log_agent_run ON public.agent_activity_log USING btree (agent_id, run_id, created_at DESC) WHERE (run_id IS NOT NULL);

CREATE INDEX idx_activity_log_run_id ON public.agent_activity_log USING btree (run_id) WHERE (run_id IS NOT NULL);

CREATE INDEX idx_agents_archived_at ON public.agents USING btree (archived_at DESC) WHERE (archived = true);

CREATE INDEX idx_containers_name_trgm ON public.containers USING gin (name public.gin_trgm_ops);

CREATE INDEX idx_docs_title_trgm ON public.docs USING gin (title public.gin_trgm_ops);

CREATE INDEX idx_files_relative_path_trgm ON public.files USING gin (relative_path public.gin_trgm_ops);

CREATE INDEX idx_memories_memory_key_trgm ON public.memories USING gin (memory_key public.gin_trgm_ops);

CREATE INDEX idx_messages_thread_run ON public.messages USING btree (thread_id, run_id) WHERE (run_id IS NOT NULL);

CREATE INDEX idx_models_active ON public.models USING btree (is_active, provider_id);

CREATE INDEX idx_nodes_archived_at ON public.nodes USING btree (archived_at DESC) WHERE (archived = true);

CREATE INDEX idx_nodes_container_sort ON public.nodes USING btree (container_id, sort_order) WHERE (archived = false);

CREATE INDEX idx_nodes_id_container ON public.nodes USING btree (id, container_id);

CREATE INDEX idx_provider_auth_types_provider_id ON public.provider_auth_types USING btree (provider_id);

CREATE INDEX idx_providers_primary_credential_id ON public.providers USING btree (primary_credential_id);

CREATE INDEX idx_runs_agent_id_created_at ON public.runs USING btree (agent_id, created_at);

CREATE INDEX idx_runs_thread_id_created_at ON public.runs USING btree (thread_id, created_at);

CREATE INDEX idx_runs_thread_status ON public.runs USING btree (thread_id, status);

CREATE INDEX idx_socket_sessions_agent_id ON public.socket_sessions USING btree (agent_id);

CREATE INDEX idx_socket_sessions_thread_id ON public.socket_sessions USING btree (thread_id);

CREATE INDEX idx_threads_title_trgm ON public.threads USING gin (title public.gin_trgm_ops);

CREATE INDEX idx_tools_category_path ON public.tools USING btree (category_path);

CREATE INDEX idx_tools_provider_id ON public.tools USING btree (provider_id);

CREATE INDEX idx_tools_source ON public.tools USING btree (source);

CREATE INDEX idx_tools_tier ON public.tools USING btree (tier);

CREATE INDEX idx_tools_type ON public.tools USING btree (type);

CREATE INDEX idx_tools_visibility ON public.tools USING btree (category_path) WHERE (enabled = true);

CREATE INDEX idx_user_provider_credentials_provider_auth_type_id ON public.user_provider_credentials USING btree (provider_id, auth_type_id, updated_at DESC);

CREATE INDEX idx_users_email ON public.users USING btree (email);

CREATE INDEX links_source_idx ON public.links USING btree (source_id, relation);

CREATE INDEX links_target_idx ON public.links USING btree (target_id, relation);

CREATE UNIQUE INDEX mcp_api_keys_key_hash_idx ON public.mcp_api_keys USING btree (key_hash);

CREATE INDEX mcp_api_keys_member_idx ON public.mcp_api_keys USING btree (member_id);

CREATE UNIQUE INDEX members_unique_agent ON public.members USING btree (agent_id) WHERE (agent_id IS NOT NULL);

CREATE UNIQUE INDEX members_unique_user ON public.members USING btree (user_id) WHERE (user_id IS NOT NULL);

CREATE INDEX memories_agent_idx ON public.memories USING btree (agent_id);

CREATE INDEX memories_created_at_idx ON public.memories USING btree (created_at DESC);

CREATE INDEX memories_member_idx ON public.memories USING btree (member_id);

CREATE INDEX memories_search_text_idx ON public.memories USING gin (search_text);

CREATE INDEX messages_agent_idx ON public.messages USING btree (agent_id) WHERE (agent_id IS NOT NULL);

CREATE INDEX messages_created_at_idx ON public.messages USING btree (created_at DESC);

CREATE INDEX messages_search_text_idx ON public.messages USING gin (search_text);

CREATE INDEX messages_thread_created_at_idx ON public.messages USING btree (thread_id, created_at DESC);

CREATE INDEX messages_unresolved_q_idx ON public.messages USING btree (thread_id) WHERE ((message_type = 'question'::text) AND (resolved = false));

CREATE INDEX messages_user_idx ON public.messages USING btree (user_id) WHERE (user_id IS NOT NULL);

CREATE INDEX messages_visible_to_agent_idx ON public.messages USING btree (visible_to_agent_id) WHERE (visible_to_agent_id IS NOT NULL);

CREATE INDEX nodes_project_id_idx ON public.nodes USING btree (project_id) WHERE (project_id IS NOT NULL);

CREATE INDEX nodes_type_idx ON public.nodes USING btree (type);

CREATE INDEX nodes_updated_at_idx ON public.nodes USING btree (updated_at DESC);

CREATE INDEX notifications_created_idx ON public.notifications USING btree (created_at DESC);

CREATE INDEX notifications_unread_idx ON public.notifications USING btree (read, dismissed, created_at DESC) WHERE ((NOT read) AND (NOT dismissed));

CREATE INDEX placement_events_node_moved_idx ON public.placement_events USING btree (node_id, moved_at);

CREATE INDEX reminder_deliveries_delivered_at_idx ON public.reminder_deliveries USING btree (delivered_at);

CREATE INDEX reminder_settings_automation_idx ON public.reminder_settings USING btree (automation_id) WHERE (kind = 'automation'::text);

CREATE INDEX reminder_settings_event_idx ON public.reminder_settings USING btree (event_id) WHERE (kind = 'event'::text);

CREATE INDEX reminder_settings_field_idx ON public.reminder_settings USING btree (field_id) WHERE (kind = 'table_entry'::text);

CREATE INDEX reminder_settings_table_entry_idx ON public.reminder_settings USING btree (table_id, entry_id) WHERE (kind = 'table_entry'::text);

CREATE INDEX schedule_runs_schedule_started_idx ON public.schedule_runs USING btree (schedule_id, started_at DESC);

CREATE INDEX schedules_due_idx ON public.schedules USING btree (next_run_at) WHERE ((enabled = true) AND (next_run_at IS NOT NULL));

CREATE UNIQUE INDEX skill_registry_builtin_slug_uq ON public.skill_registry USING btree (slug) WHERE (scope = 'builtin'::text);

CREATE UNIQUE INDEX skill_registry_personal_slug_uq ON public.skill_registry USING btree (slug) WHERE (scope = 'personal'::text);

CREATE UNIQUE INDEX skill_registry_project_slug_uq ON public.skill_registry USING btree (project_id, slug) WHERE (scope = 'project'::text);

CREATE UNIQUE INDEX subagents_agent_key ON public.subagents USING btree (agent_id);

CREATE UNIQUE INDEX subagents_live_name_key ON public.subagents USING btree (parent_thread_id, lower(name)) WHERE (deleted_at IS NULL);

CREATE INDEX subagents_orchestrator_idx ON public.subagents USING btree (orchestrator_agent_id) WHERE (deleted_at IS NULL);

CREATE INDEX subagents_parent_thread_idx ON public.subagents USING btree (parent_thread_id, created_at) WHERE (deleted_at IS NULL);

CREATE INDEX subagents_resume_due_idx ON public.subagents USING btree (resume_at) WHERE ((resume_at IS NOT NULL) AND (deleted_at IS NULL));

CREATE UNIQUE INDEX subagents_thread_key ON public.subagents USING btree (thread_id) WHERE (thread_id IS NOT NULL);

CREATE INDEX table_catalog_held_by_idx ON public.table_catalog USING btree (held_by) WHERE (held_by IS NOT NULL);

CREATE UNIQUE INDEX table_catalog_name_lower_key ON public.table_catalog USING btree (lower(name)) WHERE (state = 'active'::text);

CREATE INDEX table_catalog_project_id_idx ON public.table_catalog USING btree (project_id) WHERE (project_id IS NOT NULL);

CREATE INDEX table_entry_occurrences_entry_idx ON public.table_entry_occurrences USING btree (table_id, entry_id, created_at DESC);

CREATE INDEX table_entry_occurrences_field_idx ON public.table_entry_occurrences USING btree (field_id, created_at DESC);

CREATE UNIQUE INDEX table_entry_occurrences_once_key ON public.table_entry_occurrences USING btree (field_id, entry_id, occurrence) WHERE (kind = ANY (ARRAY['done'::text, 'skipped'::text]));

CREATE INDEX table_entry_repeats_entry_idx ON public.table_entry_repeats USING btree (table_id, entry_id);

CREATE INDEX table_fields_calendar_idx ON public.table_fields USING btree (calendar_id) WHERE (calendar_id IS NOT NULL);

CREATE INDEX table_fields_held_by_idx ON public.table_fields USING btree (held_by) WHERE (held_by IS NOT NULL);

CREATE UNIQUE INDEX table_fields_name_lower_key ON public.table_fields USING btree (table_id, lower(name)) WHERE (state = 'active'::text);

CREATE UNIQUE INDEX table_fields_position_key ON public.table_fields USING btree (table_id, "position") WHERE (state = 'active'::text);

CREATE INDEX table_fields_reference_idx ON public.table_fields USING btree (reference_table_id) WHERE (reference_table_id IS NOT NULL);

CREATE INDEX table_fields_reference_kind_idx ON public.table_fields USING btree (reference_kind) WHERE (reference_kind IS NOT NULL);

CREATE UNIQUE INDEX table_fields_title_key ON public.table_fields USING btree (table_id) WHERE (is_title AND (state = 'active'::text));

CREATE INDEX table_history_recent_idx ON public.table_history USING btree (updated_at DESC, id);

CREATE INDEX thread_participants_member_idx ON public.thread_participants USING btree (member_id);

CREATE UNIQUE INDEX thread_participants_unique_member ON public.thread_participants USING btree (thread_id, member_id);

CREATE INDEX thread_summaries_created_at_idx ON public.thread_summaries USING btree (created_at DESC);

CREATE UNIQUE INDEX thread_summaries_current_idx ON public.thread_summaries USING btree (thread_id, COALESCE(agent_id, '__none__'::text)) WHERE (is_current = true);

CREATE INDEX thread_summaries_search_text_idx ON public.thread_summaries USING gin (search_text);

CREATE INDEX thread_summaries_thread_idx ON public.thread_summaries USING btree (thread_id);

CREATE INDEX threads_created_at_idx ON public.threads USING btree (created_at DESC);

CREATE UNIQUE INDEX threads_dm_pair_key_key ON public.threads USING btree (dm_pair_key) WHERE (dm_pair_key IS NOT NULL);

CREATE INDEX threads_last_message_at_idx ON public.threads USING btree (last_message_at DESC NULLS LAST);

CREATE INDEX threads_parent_thread_idx ON public.threads USING btree (parent_thread_id) WHERE (parent_thread_id IS NOT NULL);

CREATE INDEX tools_aliases_gin_idx ON public.tools USING gin (aliases);

CREATE INDEX tools_search_text_idx ON public.tools USING gin (search_text);

CREATE UNIQUE INDEX users_one_active_idx ON public.users USING btree (active) WHERE (active = true);

--
-- Triggers
--

CREATE TRIGGER agents_block_ghost_delete_trg BEFORE DELETE ON public.agents FOR EACH ROW EXECUTE FUNCTION public.agents_block_ghost_delete();

CREATE TRIGGER calendar_events_series_guard BEFORE INSERT OR UPDATE ON public.calendar_events FOR EACH ROW EXECUTE FUNCTION public.calendar_event_series_guard();

CREATE TRIGGER doc_links_sync_insert AFTER INSERT ON public.docs FOR EACH ROW EXECUTE FUNCTION public.sync_doc_links();

CREATE TRIGGER doc_links_sync_update AFTER UPDATE OF content ON public.docs FOR EACH ROW EXECUTE FUNCTION public.sync_doc_links();

CREATE TRIGGER subagents_delete_helper_thread_trg AFTER DELETE ON public.subagents FOR EACH ROW EXECUTE FUNCTION public.subagents_delete_helper_thread();

CREATE TRIGGER trg_a_links_cleanup_on_archive AFTER UPDATE OF archived ON public.nodes FOR EACH ROW EXECUTE FUNCTION public.cleanup_links_on_node_archive();

CREATE TRIGGER trg_b1_cascade_archive AFTER UPDATE OF archived ON public.nodes FOR EACH ROW EXECUTE FUNCTION public.cascade_archive_descendants();

CREATE TRIGGER trg_b2_cascade_restore AFTER UPDATE OF archived ON public.nodes FOR EACH ROW EXECUTE FUNCTION public.cascade_restore_descendants();

CREATE TRIGGER trg_b3_cascade_thread_memories AFTER UPDATE OF archived ON public.nodes FOR EACH ROW WHEN (((new.type = 'thread'::public.node_type) OR (old.type = 'thread'::public.node_type))) EXECUTE FUNCTION public.cascade_archive_thread_memories();

CREATE TRIGGER trg_c_orphan_null_on_delete BEFORE DELETE ON public.nodes FOR EACH ROW EXECUTE FUNCTION public.orphan_null_on_container_delete();

CREATE TRIGGER trg_containers_project_category_guard BEFORE UPDATE OF category ON public.containers FOR EACH ROW EXECUTE FUNCTION public.containers_project_category_guard();

CREATE TRIGGER trg_d_archived_immutable_guard BEFORE UPDATE ON public.nodes FOR EACH ROW EXECUTE FUNCTION public.archived_node_immutable_guard();

CREATE TRIGGER trg_docs_update_search_text BEFORE INSERT OR UPDATE OF title, content ON public.docs FOR EACH ROW EXECUTE FUNCTION public.docs_update_search_text();

CREATE TRIGGER trg_e2_relink_doc_on_restore AFTER UPDATE OF archived ON public.nodes FOR EACH ROW WHEN (((old.archived = true) AND (new.archived = false) AND (new.type = 'doc'::public.node_type))) EXECUTE FUNCTION public.relink_doc_on_restore();

CREATE TRIGGER trg_e_restore_notify AFTER UPDATE OF archived ON public.nodes FOR EACH ROW EXECUTE FUNCTION public.notify_node_restored();

CREATE TRIGGER trg_messages_update_thread_last AFTER INSERT ON public.messages FOR EACH ROW EXECUTE FUNCTION public.update_thread_last_message();

CREATE TRIGGER trg_nodes_container_no_cycle BEFORE INSERT OR UPDATE OF container_id ON public.nodes FOR EACH ROW EXECUTE FUNCTION public.check_nodes_container_no_cycle();

CREATE TRIGGER trg_nodes_project_scope_guard BEFORE INSERT OR UPDATE OF project_id ON public.nodes FOR EACH ROW EXECUTE FUNCTION public.nodes_project_scope_guard();

CREATE TRIGGER trg_table_catalog_project_scope_guard BEFORE INSERT OR UPDATE OF project_id ON public.table_catalog FOR EACH ROW EXECUTE FUNCTION public.table_catalog_project_scope_guard();

CREATE TRIGGER trg_validate_link_triple BEFORE INSERT OR UPDATE OF source_id, target_id, relation ON public.links FOR EACH ROW EXECUTE FUNCTION public.validate_link_triple();

--
-- Foreign keys
--

ALTER TABLE ONLY public.agent_activity_log
    ADD CONSTRAINT agent_activity_log_agent_id_fkey FOREIGN KEY (agent_id) REFERENCES public.agents(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE ONLY public.agent_activity_log
    ADD CONSTRAINT agent_activity_log_run_id_fkey FOREIGN KEY (run_id) REFERENCES public.runs(id) ON DELETE SET NULL;

ALTER TABLE ONLY public.agent_skill_assignments
    ADD CONSTRAINT agent_skill_assignments_agent_id_fkey FOREIGN KEY (agent_id) REFERENCES public.agents(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.agent_skill_assignments
    ADD CONSTRAINT agent_skill_assignments_skill_id_fkey FOREIGN KEY (skill_id) REFERENCES public.skill_registry(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.agent_skill_assignments
    ADD CONSTRAINT agent_skill_assignments_thread_id_fkey FOREIGN KEY (thread_id) REFERENCES public.threads(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.agents
    ADD CONSTRAINT agents_parent_agent_id_fkey FOREIGN KEY (parent_agent_id) REFERENCES public.agents(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE ONLY public.automations
    ADD CONSTRAINT automations_agent_id_fkey FOREIGN KEY (agent_id) REFERENCES public.agents(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.automations
    ADD CONSTRAINT automations_calendar_id_fkey FOREIGN KEY (calendar_id) REFERENCES public.calendars(id) ON DELETE SET NULL;

ALTER TABLE ONLY public.automations
    ADD CONSTRAINT automations_schedule_id_fkey FOREIGN KEY (schedule_id) REFERENCES public.schedules(id) ON DELETE SET NULL;

ALTER TABLE ONLY public.automations
    ADD CONSTRAINT automations_thread_id_fkey FOREIGN KEY (thread_id) REFERENCES public.threads(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.calendar_events
    ADD CONSTRAINT calendar_events_calendar_id_fkey FOREIGN KEY (calendar_id) REFERENCES public.calendars(id) ON DELETE RESTRICT;

ALTER TABLE ONLY public.calendar_events
    ADD CONSTRAINT calendar_events_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.members(id) ON DELETE SET NULL;

ALTER TABLE ONLY public.calendar_events
    ADD CONSTRAINT calendar_events_id_fkey FOREIGN KEY (id) REFERENCES public.nodes(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE ONLY public.calendar_events
    ADD CONSTRAINT calendar_events_last_edited_by_fkey FOREIGN KEY (last_edited_by) REFERENCES public.members(id) ON DELETE SET NULL;

ALTER TABLE ONLY public.calendar_events
    ADD CONSTRAINT calendar_events_recurring_event_id_fkey FOREIGN KEY (recurring_event_id) REFERENCES public.calendar_events(id) ON UPDATE CASCADE;

ALTER TABLE ONLY public.calendars
    ADD CONSTRAINT calendars_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.members(id) ON DELETE SET NULL;

ALTER TABLE ONLY public.containers
    ADD CONSTRAINT containers_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.members(id) ON UPDATE CASCADE ON DELETE SET NULL;

ALTER TABLE ONLY public.containers
    ADD CONSTRAINT containers_id_fkey FOREIGN KEY (id) REFERENCES public.nodes(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.containers
    ADD CONSTRAINT containers_last_edited_by_fkey FOREIGN KEY (last_edited_by) REFERENCES public.members(id) ON UPDATE CASCADE ON DELETE SET NULL;

ALTER TABLE ONLY public.doc_edit_state
    ADD CONSTRAINT doc_edit_state_doc_id_fkey FOREIGN KEY (doc_id) REFERENCES public.docs(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.doc_snapshots
    ADD CONSTRAINT doc_snapshots_doc_id_fkey FOREIGN KEY (doc_id) REFERENCES public.docs(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.docs
    ADD CONSTRAINT docs_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.members(id) ON UPDATE CASCADE ON DELETE SET NULL;

ALTER TABLE ONLY public.docs
    ADD CONSTRAINT docs_id_fkey FOREIGN KEY (id) REFERENCES public.nodes(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.docs
    ADD CONSTRAINT docs_last_edited_by_fkey FOREIGN KEY (last_edited_by) REFERENCES public.members(id) ON UPDATE CASCADE ON DELETE SET NULL;

ALTER TABLE ONLY public.embeddings
    ADD CONSTRAINT embeddings_model_id_fkey FOREIGN KEY (model_id) REFERENCES public.models(id);

ALTER TABLE ONLY public.embeddings
    ADD CONSTRAINT embeddings_node_id_fkey FOREIGN KEY (node_id) REFERENCES public.nodes(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE ONLY public.file_embeddings
    ADD CONSTRAINT file_embeddings_model_id_fkey FOREIGN KEY (model_id) REFERENCES public.models(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.files
    ADD CONSTRAINT files_id_fkey FOREIGN KEY (id) REFERENCES public.nodes(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.files
    ADD CONSTRAINT files_project_id_fkey FOREIGN KEY (project_id) REFERENCES public.containers(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.hook_registrations
    ADD CONSTRAINT hook_registrations_run_as_agent_id_fkey FOREIGN KEY (run_as_agent_id) REFERENCES public.agents(id) ON DELETE SET NULL;

ALTER TABLE ONLY public.images
    ADD CONSTRAINT images_id_fkey FOREIGN KEY (id) REFERENCES public.nodes(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE ONLY public.links
    ADD CONSTRAINT links_source_id_fkey FOREIGN KEY (source_id) REFERENCES public.nodes(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.links
    ADD CONSTRAINT links_target_id_fkey FOREIGN KEY (target_id) REFERENCES public.nodes(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE ONLY public.mcp_api_keys
    ADD CONSTRAINT mcp_api_keys_member_id_fkey FOREIGN KEY (member_id) REFERENCES public.members(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE ONLY public.mcp_servers
    ADD CONSTRAINT mcp_servers_provider_id_fkey FOREIGN KEY (provider_id) REFERENCES public.providers(id) ON DELETE SET NULL;

ALTER TABLE ONLY public.members
    ADD CONSTRAINT members_agent_id_fkey FOREIGN KEY (agent_id) REFERENCES public.agents(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE ONLY public.members
    ADD CONSTRAINT members_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE ONLY public.memories
    ADD CONSTRAINT memories_agent_id_fkey FOREIGN KEY (agent_id) REFERENCES public.agents(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE ONLY public.memories
    ADD CONSTRAINT memories_id_fkey FOREIGN KEY (id) REFERENCES public.nodes(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.memories
    ADD CONSTRAINT memories_member_id_fkey FOREIGN KEY (member_id) REFERENCES public.members(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE ONLY public.memories
    ADD CONSTRAINT memories_source_thread_id_fkey FOREIGN KEY (source_thread_id) REFERENCES public.nodes(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.messages
    ADD CONSTRAINT messages_agent_id_fkey1 FOREIGN KEY (agent_id) REFERENCES public.agents(id) ON UPDATE CASCADE ON DELETE SET NULL;

ALTER TABLE ONLY public.messages
    ADD CONSTRAINT messages_id_fkey FOREIGN KEY (id) REFERENCES public.nodes(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE ONLY public.messages
    ADD CONSTRAINT messages_run_id_fkey FOREIGN KEY (run_id) REFERENCES public.runs(id) ON DELETE SET NULL;

ALTER TABLE ONLY public.messages
    ADD CONSTRAINT messages_thread_id_fkey1 FOREIGN KEY (thread_id) REFERENCES public.threads(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.messages
    ADD CONSTRAINT messages_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE SET NULL;

ALTER TABLE ONLY public.models
    ADD CONSTRAINT models_provider_id_fkey FOREIGN KEY (provider_id) REFERENCES public.providers(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.nodes
    ADD CONSTRAINT nodes_container_id_fkey FOREIGN KEY (container_id) REFERENCES public.nodes(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.nodes
    ADD CONSTRAINT nodes_project_id_fkey FOREIGN KEY (project_id) REFERENCES public.nodes(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.placement_events
    ADD CONSTRAINT placement_events_moved_by_fkey FOREIGN KEY (moved_by) REFERENCES public.members(id) ON UPDATE CASCADE ON DELETE SET NULL;

ALTER TABLE ONLY public.placement_events
    ADD CONSTRAINT placement_events_node_id_fkey FOREIGN KEY (node_id) REFERENCES public.nodes(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.provider_auth_types
    ADD CONSTRAINT provider_auth_types_provider_id_fkey FOREIGN KEY (provider_id) REFERENCES public.providers(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.provider_fallback_credentials
    ADD CONSTRAINT provider_fallback_credentials_credential_id_fkey FOREIGN KEY (credential_id) REFERENCES public.user_provider_credentials(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.provider_fallback_credentials
    ADD CONSTRAINT provider_fallback_credentials_provider_id_fkey FOREIGN KEY (provider_id) REFERENCES public.providers(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.providers
    ADD CONSTRAINT providers_primary_credential_id_fkey FOREIGN KEY (primary_credential_id) REFERENCES public.user_provider_credentials(id) ON DELETE SET NULL;

ALTER TABLE ONLY public.reminder_settings
    ADD CONSTRAINT reminder_settings_automation_id_fkey FOREIGN KEY (automation_id) REFERENCES public.automations(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.reminder_settings
    ADD CONSTRAINT reminder_settings_event_id_fkey FOREIGN KEY (event_id) REFERENCES public.calendar_events(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE ONLY public.reminder_settings
    ADD CONSTRAINT reminder_settings_field_id_fkey FOREIGN KEY (field_id) REFERENCES public.table_fields(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.reminder_settings
    ADD CONSTRAINT reminder_settings_table_id_fkey FOREIGN KEY (table_id) REFERENCES public.table_catalog(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.runs
    ADD CONSTRAINT runs_agent_id_fkey FOREIGN KEY (agent_id) REFERENCES public.agents(id) ON UPDATE CASCADE ON DELETE SET NULL;

ALTER TABLE ONLY public.runs
    ADD CONSTRAINT runs_thread_id_fkey FOREIGN KEY (thread_id) REFERENCES public.threads(id) ON DELETE SET NULL;

ALTER TABLE ONLY public.schedule_runs
    ADD CONSTRAINT schedule_runs_schedule_id_fkey FOREIGN KEY (schedule_id) REFERENCES public.schedules(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.settings
    ADD CONSTRAINT settings_updated_by_agent_id_fkey FOREIGN KEY (updated_by_agent_id) REFERENCES public.agents(id) ON UPDATE CASCADE ON DELETE SET NULL;

ALTER TABLE ONLY public.settings
    ADD CONSTRAINT settings_updated_by_user_id_fkey FOREIGN KEY (updated_by_user_id) REFERENCES public.users(id) ON DELETE SET NULL;

ALTER TABLE ONLY public.skill_registry
    ADD CONSTRAINT skill_registry_project_id_fkey FOREIGN KEY (project_id) REFERENCES public.nodes(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.socket_sessions
    ADD CONSTRAINT socket_sessions_agent_id_fkey FOREIGN KEY (agent_id) REFERENCES public.agents(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE ONLY public.socket_sessions
    ADD CONSTRAINT socket_sessions_thread_id_fkey FOREIGN KEY (thread_id) REFERENCES public.threads(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.subagents
    ADD CONSTRAINT subagents_agent_id_fkey FOREIGN KEY (agent_id) REFERENCES public.agents(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE ONLY public.subagents
    ADD CONSTRAINT subagents_delivered_run_id_fkey FOREIGN KEY (delivered_run_id) REFERENCES public.runs(id) ON DELETE SET NULL;

ALTER TABLE ONLY public.subagents
    ADD CONSTRAINT subagents_last_reply_message_id_fkey FOREIGN KEY (last_reply_message_id) REFERENCES public.messages(id) ON DELETE SET NULL;

ALTER TABLE ONLY public.subagents
    ADD CONSTRAINT subagents_last_result_message_id_fkey FOREIGN KEY (last_result_message_id) REFERENCES public.messages(id) ON DELETE SET NULL;

ALTER TABLE ONLY public.subagents
    ADD CONSTRAINT subagents_orchestrator_agent_id_fkey FOREIGN KEY (orchestrator_agent_id) REFERENCES public.agents(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE ONLY public.subagents
    ADD CONSTRAINT subagents_parent_thread_id_fkey FOREIGN KEY (parent_thread_id) REFERENCES public.nodes(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.subagents
    ADD CONSTRAINT subagents_started_by_run_id_fkey FOREIGN KEY (started_by_run_id) REFERENCES public.runs(id) ON DELETE SET NULL;

ALTER TABLE ONLY public.subagents
    ADD CONSTRAINT subagents_thread_id_fkey FOREIGN KEY (thread_id) REFERENCES public.nodes(id) ON DELETE SET NULL;

ALTER TABLE ONLY public.table_catalog
    ADD CONSTRAINT table_catalog_project_id_fkey FOREIGN KEY (project_id) REFERENCES public.nodes(id) ON DELETE SET NULL;

ALTER TABLE ONLY public.table_entry_embeddings
    ADD CONSTRAINT table_entry_embeddings_table_id_fkey FOREIGN KEY (table_id) REFERENCES public.table_catalog(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.table_entry_occurrences
    ADD CONSTRAINT table_entry_occurrences_field_id_fkey FOREIGN KEY (field_id) REFERENCES public.table_fields(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.table_entry_occurrences
    ADD CONSTRAINT table_entry_occurrences_table_id_fkey FOREIGN KEY (table_id) REFERENCES public.table_catalog(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.table_entry_repeats
    ADD CONSTRAINT table_entry_repeats_field_id_fkey FOREIGN KEY (field_id) REFERENCES public.table_fields(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.table_entry_repeats
    ADD CONSTRAINT table_entry_repeats_table_id_fkey FOREIGN KEY (table_id) REFERENCES public.table_catalog(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.table_fields
    ADD CONSTRAINT table_fields_calendar_id_fkey FOREIGN KEY (calendar_id) REFERENCES public.calendars(id) ON DELETE SET NULL;

ALTER TABLE ONLY public.table_fields
    ADD CONSTRAINT table_fields_reference_table_id_fkey FOREIGN KEY (reference_table_id) REFERENCES public.table_catalog(id) ON DELETE SET NULL;

ALTER TABLE ONLY public.table_fields
    ADD CONSTRAINT table_fields_table_id_fkey FOREIGN KEY (table_id) REFERENCES public.table_catalog(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.table_semantic_search
    ADD CONSTRAINT table_semantic_search_table_id_fkey FOREIGN KEY (table_id) REFERENCES public.table_catalog(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.thread_notification_settings
    ADD CONSTRAINT thread_notification_settings_thread_id_fkey FOREIGN KEY (thread_id) REFERENCES public.threads(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.thread_participants
    ADD CONSTRAINT thread_participants_member_id_fkey FOREIGN KEY (member_id) REFERENCES public.members(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE ONLY public.thread_participants
    ADD CONSTRAINT thread_participants_thread_id_fkey FOREIGN KEY (thread_id) REFERENCES public.nodes(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.thread_summaries
    ADD CONSTRAINT thread_summaries_agent_id_fkey FOREIGN KEY (agent_id) REFERENCES public.agents(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE ONLY public.thread_summaries
    ADD CONSTRAINT thread_summaries_id_fkey FOREIGN KEY (id) REFERENCES public.nodes(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.thread_summaries
    ADD CONSTRAINT thread_summaries_last_message_id_fkey FOREIGN KEY (last_message_id) REFERENCES public.messages(id) ON DELETE SET NULL;

ALTER TABLE ONLY public.thread_summaries
    ADD CONSTRAINT thread_summaries_thread_id_fkey FOREIGN KEY (thread_id) REFERENCES public.nodes(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.threads
    ADD CONSTRAINT threads_id_fkey FOREIGN KEY (id) REFERENCES public.nodes(id) ON DELETE CASCADE;

--
-- Database defaults. HNSW ordered scans return at most hnsw.ef_search rows
-- (PostgreSQL default 40); search fetches candidate pools of up to ~50 before
-- dedup/rerank, so the database default is raised comfortably above the
-- largest pool. New sessions pick it up automatically.
--

DO $$
BEGIN
  EXECUTE format('ALTER DATABASE %I SET hnsw.ef_search = 100', current_database());
END $$;

RESET search_path;
RESET check_function_bodies;

--
-- Built-in rows. First the builtin catalog: every file in ./seeds/, verbatim
-- below its shared header, in the order `ensureBuiltinCatalog` replays them
-- (provider-catalog.sql, then SEED_REPLAY_FILES, then local-models.sql). Keep
-- this section and ./seeds/ identical.
--

-- seeds/provider-catalog.sql
--
-- Base LLM/integration provider catalog + auth types. Runs FIRST: the later
-- seeds insert rows that reference these providers.

INSERT INTO public.providers (id, name, description, website, api_docs, sort_order, default_metadata, base_url, type) VALUES ('anthropic', 'Anthropic', 'Claude family — Opus, Sonnet, Haiku', 'https://anthropic.com', 'https://docs.anthropic.com', 0, '{"summary": {"maxWords": 600, "defaultModelId": "claude-haiku-4-5", "messageThreshold": 10}, "contextCompression": {"triggerRatio": 0.7, "recentVerbatim": 15, "maxSummaryChars": 3500, "compressAfterMessages": 8}}', NULL, 'llm') ON CONFLICT (id) DO NOTHING;
INSERT INTO public.providers (id, name, description, website, api_docs, sort_order, default_metadata, base_url, type) VALUES ('openai', 'OpenAI', 'GPT models', 'https://openai.com', 'https://platform.openai.com/docs', 1, '{"summary": {"maxWords": 600, "defaultModelId": "gpt-4o-mini", "messageThreshold": 10}, "contextCompression": {"triggerRatio": 0.6, "recentVerbatim": 10, "maxSummaryChars": 3500, "compressAfterMessages": 6}}', NULL, 'llm') ON CONFLICT (id) DO NOTHING;
INSERT INTO public.providers (id, name, description, website, api_docs, sort_order, default_metadata, base_url, type) VALUES ('google', 'Google', 'Gemini models', 'https://deepmind.google', 'https://ai.google.dev/docs', 2, '{"summary": {"maxWords": 600, "messageThreshold": 10}, "contextCompression": {"triggerRatio": 0.6, "recentVerbatim": 10, "maxSummaryChars": 3500, "compressAfterMessages": 6}}', NULL, 'llm') ON CONFLICT (id) DO NOTHING;
INSERT INTO public.providers (id, name, description, website, api_docs, sort_order, default_metadata, base_url, type) VALUES ('mistral', 'Mistral AI', 'Mistral Large, Mistral Small, Mixtral 8x22B', 'https://mistral.ai', 'https://docs.mistral.ai', 3, '{"defaultModelId": "mistral-large-latest", "summary": {"maxWords": 600, "messageThreshold": 10}, "contextCompression": {"triggerRatio": 0.6, "recentVerbatim": 10, "maxSummaryChars": 3500, "compressAfterMessages": 6}}', NULL, 'llm') ON CONFLICT (id) DO NOTHING;
INSERT INTO public.providers (id, name, description, website, api_docs, sort_order, default_metadata, base_url, type) VALUES ('codex', 'OpenAI Codex', 'Codex — OpenAI''s coding-focused model for agentic dev tasks', 'https://openai.com', 'https://platform.openai.com/docs/models', 5, '{"summary": {"maxWords": 600, "defaultModelId": "gpt-4o-mini", "messageThreshold": 10}, "contextCompression": {"triggerRatio": 0.6, "recentVerbatim": 10, "maxSummaryChars": 3500, "compressAfterMessages": 6}}', NULL, 'llm') ON CONFLICT (id) DO NOTHING;
INSERT INTO public.providers (id, name, description, website, api_docs, sort_order, default_metadata, base_url, type) VALUES ('copilot', 'GitHub Copilot', 'Models from your GitHub Copilot subscription', 'https://github.com/features/copilot', 'https://docs.github.com/en/copilot', 6, '{"summary": {"maxWords": 600, "messageThreshold": 10}, "contextCompression": {"triggerRatio": 0.6, "recentVerbatim": 10, "maxSummaryChars": 3500, "compressAfterMessages": 6}}', NULL, 'llm') ON CONFLICT (id) DO NOTHING;
INSERT INTO public.providers (id, name, description, website, api_docs, sort_order, default_metadata, base_url, type) VALUES ('ollama', 'Ollama', 'Local open-weight models via the Ollama daemon', 'https://ollama.com', 'https://github.com/ollama/ollama/blob/main/docs/api.md', 7, '{}', 'http://127.0.0.1:11434/v1', 'llm') ON CONFLICT (id) DO NOTHING;
INSERT INTO public.providers (id, name, description, website, api_docs, sort_order, default_metadata, base_url, type) VALUES ('together', 'Together AI', 'Hosted open-weight models (Llama, Gemma, Mistral, Qwen, DeepSeek, etc.) with full tool-calling support via an OpenAI-compatible API.', 'https://together.ai', 'https://docs.together.ai/docs/openai-api-compatibility', 9, '{"defaultModelId": "zai-org/GLM-5.3-Flash"}', 'https://api.together.xyz', 'llm') ON CONFLICT (id) DO NOTHING;
INSERT INTO public.providers (id, name, description, website, api_docs, sort_order, default_metadata, base_url, type) VALUES ('lm-studio', 'LM Studio', 'Local OpenAI-compatible server bundled with the LM Studio desktop app. Loads GGUF models on demand and ships chat templates that handle tool calling for many models (Gemma 3, Llama 3, Qwen, etc.).', 'https://lmstudio.ai', 'https://lmstudio.ai/docs/local-server', 10, '{}', 'http://localhost:1234/v1', 'llm') ON CONFLICT (id) DO NOTHING;
INSERT INTO public.providers (id, name, description, website, api_docs, sort_order, default_metadata, base_url, type) VALUES ('snaglet-local', 'Snaglet Local Runtime', 'Local runtime assets managed by Snaglet, starting with the built-in MiniLM reranker for context curation.', NULL, NULL, 11, '{}', NULL, 'runtime') ON CONFLICT (id) DO NOTHING;
INSERT INTO public.providers (id, name, description, website, api_docs, sort_order, default_metadata, base_url, type) VALUES ('google-workspace', 'Google Workspace', 'Read your Google Calendar and Drive. Connect with a Google account via OAuth.', 'https://workspace.google.com', 'https://developers.google.com/workspace', 101, '{}', NULL, 'integration') ON CONFLICT (id) DO NOTHING;
INSERT INTO public.providers (id, name, description, website, api_docs, sort_order, default_metadata, base_url, type) VALUES ('github', 'GitHub', 'Snaglet reads an optional GitHub token from here to check for new releases. It adds no GitHub tools or MCP integration.', 'https://github.com', 'https://docs.github.com/en/rest', 110, '{}', NULL, 'integration') ON CONFLICT (id) DO NOTHING;

INSERT INTO public.provider_auth_types (id, provider_id, name, type, description, token_label, token_placeholder, token_help, sort_order, auth_header) VALUES ('anthropic:api-key', 'anthropic', 'API Key', 'api_key', 'Use a direct Anthropic API key.', 'API Key', 'sk-ant-api03-…', 'Get your key at console.anthropic.com → API Keys.', 1, 'x-api-key') ON CONFLICT (id) DO NOTHING;
INSERT INTO public.provider_auth_types (id, provider_id, name, type, description, token_label, token_placeholder, token_help, sort_order, auth_header) VALUES ('anthropic:claude-code-pro', 'anthropic', 'Claude Code Pro', 'oauth', 'Use your Claude Code Pro subscription token.', 'OAuth Token', 'sk-ant-oat01-…', 'Run `claude auth token` in your terminal to get this.', 0, 'x-api-key') ON CONFLICT (id) DO NOTHING;
INSERT INTO public.provider_auth_types (id, provider_id, name, type, description, token_label, token_placeholder, token_help, sort_order, auth_header) VALUES ('codex:api-key', 'codex', 'API Key', 'api_key', 'Use an OpenAI API key with Codex model access.', 'API Key', 'sk-…', 'Get your key at platform.openai.com → API Keys.', 1, 'Authorization') ON CONFLICT (id) DO NOTHING;
INSERT INTO public.provider_auth_types (id, provider_id, name, type, description, token_label, token_placeholder, token_help, sort_order, auth_header) VALUES ('codex:codex-subscription', 'codex', 'Codex Subscription', 'oauth', 'Use your OpenAI Codex / GitHub Copilot subscription.', 'Subscription Token', 'ghu_…', 'Authenticate via GitHub Copilot or the Codex CLI.', 0, 'Authorization') ON CONFLICT (id) DO NOTHING;
INSERT INTO public.provider_auth_types (id, provider_id, name, type, description, token_label, token_placeholder, token_help, sort_order, auth_header) VALUES ('copilot:api-key', 'copilot', 'API Key', 'api_key', 'Use a GitHub personal access token with Copilot scope.', 'API Key', 'ghp_…', 'Get your token at github.com/settings/tokens with the Copilot scope.', 1, 'Authorization') ON CONFLICT (id) DO NOTHING;
INSERT INTO public.provider_auth_types (id, provider_id, name, type, description, token_label, token_placeholder, token_help, sort_order, auth_header) VALUES ('copilot:subscription', 'copilot', 'GitHub OAuth', 'oauth', 'Use your GitHub OAuth token (gho_*). The server exchanges it for a Copilot subscription token at runtime.', 'GitHub Token', 'gho_…', 'Run the GitHub device code flow or use an existing gho_* token from your GitHub Copilot setup.', 0, 'Authorization') ON CONFLICT (id) DO NOTHING;
INSERT INTO public.provider_auth_types (id, provider_id, name, type, description, token_label, token_placeholder, token_help, sort_order, auth_header) VALUES ('github:personal-access-token', 'github', 'Personal Access Token', 'api_key', 'Use a GitHub personal access token (classic or fine-grained). Scope determines what Snaglet can read or write.', 'Personal Access Token', 'ghp_… or github_pat_…', 'Create one at github.com/settings/tokens. For fine-grained tokens, grant the repos and scopes you want Snaglet to access.', 0, 'Authorization') ON CONFLICT (id) DO NOTHING;
INSERT INTO public.provider_auth_types (id, provider_id, name, type, description, token_label, token_placeholder, token_help, sort_order, auth_header) VALUES ('google-workspace:oauth', 'google-workspace', 'Google OAuth', 'oauth', 'Connect a Google account via OAuth. Snaglet stores access + refresh tokens and refreshes them automatically.', NULL, NULL, 'Click Connect to authorize Snaglet against your Google account. Snaglet asks for read and write access to Calendar, Docs, Sheets, Forms, Gmail and Drive.', 0, NULL) ON CONFLICT (id) DO NOTHING;
INSERT INTO public.provider_auth_types (id, provider_id, name, type, description, token_label, token_placeholder, token_help, sort_order, auth_header) VALUES ('google:api-key', 'google', 'API Key', 'api_key', 'Use a Google AI Studio API key.', 'API Key', 'AIzaSy…', 'Get your key at aistudio.google.com → API Keys.', 0, 'Authorization') ON CONFLICT (id) DO NOTHING;
INSERT INTO public.provider_auth_types (id, provider_id, name, type, description, token_label, token_placeholder, token_help, sort_order, auth_header) VALUES ('lm-studio:none', 'lm-studio', 'No Auth', 'none', 'Connect directly to a local LM Studio server. No API key is required.', NULL, NULL, 'Open LM Studio → Developer tab → load a model → toggle the server to Running. Default URL is http://localhost:1234.', 0, NULL) ON CONFLICT (id) DO NOTHING;
INSERT INTO public.provider_auth_types (id, provider_id, name, type, description, token_label, token_placeholder, token_help, sort_order, auth_header) VALUES ('mistral:api-key', 'mistral', 'API Key', 'api_key', 'Use a Mistral AI API key.', 'API Key', '', 'Get your key at console.mistral.ai → API Keys.', 0, 'Authorization') ON CONFLICT (id) DO NOTHING;
INSERT INTO public.provider_auth_types (id, provider_id, name, type, description, token_label, token_placeholder, token_help, sort_order, auth_header) VALUES ('ollama:none', 'ollama', 'No Auth', 'none', 'Connect directly to a local Ollama daemon. No API key is required.', NULL, NULL, 'Ollama runs locally by default at http://127.0.0.1:11434.', 0, NULL) ON CONFLICT (id) DO NOTHING;
INSERT INTO public.provider_auth_types (id, provider_id, name, type, description, token_label, token_placeholder, token_help, sort_order, auth_header) VALUES ('openai:api-key', 'openai', 'API Key', 'api_key', 'Use an OpenAI API key.', 'API Key', 'sk-…', 'Get your key at platform.openai.com → API Keys.', 0, 'Authorization') ON CONFLICT (id) DO NOTHING;
INSERT INTO public.provider_auth_types (id, provider_id, name, type, description, token_label, token_placeholder, token_help, sort_order, auth_header) VALUES ('together:api-key', 'together', 'API Key', 'api_key', 'Bearer token for the Together AI REST API.', 'API Key', 'tgp_v1_…', 'Get your key at api.together.ai → Settings → API Keys.', 0, 'Authorization') ON CONFLICT (id) DO NOTHING;

-- seeds/provider-snaglet-local.sql
--
-- The snaglet-local runtime provider card. Its reranker model row is in
-- local-models.sql.

INSERT INTO public.providers (
  id,
  name,
  description,
  website,
  api_docs,
  sort_order,
  default_metadata,
  base_url,
  type
) VALUES (
  'snaglet-local',
  'Snaglet Local Runtime',
  'Local runtime assets managed by Snaglet, starting with the built-in MiniLM reranker for context curation.',
  NULL,
  NULL,
  11,
  '{}'::jsonb,
  NULL,
  'runtime'
) ON CONFLICT (id) DO UPDATE SET
  name = EXCLUDED.name,
  description = EXCLUDED.description,
  sort_order = EXCLUDED.sort_order,
  default_metadata = EXCLUDED.default_metadata,
  base_url = EXCLUDED.base_url,
  type = EXCLUDED.type,
  updated_at = NOW();

-- seeds/provider-deepseek.sql
--
-- DeepSeek provider card + its API-key auth type.

INSERT INTO public.providers (id, name, description, website, api_docs, sort_order, default_metadata, base_url, type) VALUES ('deepseek', 'DeepSeek', 'DeepSeek-V3 (chat) and DeepSeek-R1 (reasoner) via an OpenAI-compatible API.', 'https://deepseek.com', 'https://api-docs.deepseek.com', 23, '{"defaultModelId": "deepseek-v4-pro", "summary": {"maxWords": 600, "messageThreshold": 10}, "contextCompression": {"triggerRatio": 0.6, "recentVerbatim": 10, "maxSummaryChars": 3500, "compressAfterMessages": 6}}', NULL, 'llm') ON CONFLICT (id) DO NOTHING;

-- provider_auth_types
INSERT INTO public.provider_auth_types (id, provider_id, name, type, description, token_label, token_placeholder, token_help, sort_order, auth_header) VALUES ('deepseek:api-key', 'deepseek', 'API Key', 'api_key', 'Use a DeepSeek API key.', 'API Key', 'sk-…', 'Get your key at platform.deepseek.com → API Keys.', 0, 'Authorization') ON CONFLICT (id) DO NOTHING;

-- seeds/ghost-agent.sql
--
-- The permanent "ghost" system agent + its member principal. When an agent is
-- permanently deleted, every kept reference (messages, runs, activity log,
-- workspace attribution) is repointed to ghost so history never goes
-- authorless. The schema's BEFORE DELETE trigger
-- (`agents_block_ghost_delete_trg`) makes the ghost row undeletable.

INSERT INTO public.agents (id, name, role)
VALUES ('ghost', 'ghost', 'System')
ON CONFLICT DO NOTHING;

-- Ghost's principal identity row. kind='agent' with agent_id set satisfies
-- members_principal_match; the agent_id FK resolves to the row seeded above.
-- Bare ON CONFLICT DO NOTHING absorbs a conflict on the id PK or the
-- members_unique_agent partial index (a member already existing for ghost).
INSERT INTO public.members (id, kind, agent_id)
VALUES ('ghost', 'agent', 'ghost')
ON CONFLICT DO NOTHING;

-- seeds/provider-xai.sql
--
-- xAI (Grok) provider card + auth type.

INSERT INTO public.providers (id, name, description, website, api_docs, sort_order, default_metadata, base_url, type) VALUES ('xai', 'xAI (Grok)', 'Grok models (grok-4, grok-3, grok-2, …) from xAI via an OpenAI-compatible API.', 'https://x.ai', 'https://docs.x.ai', 25, '{"summary": {"maxWords": 600, "messageThreshold": 10}, "contextCompression": {"triggerRatio": 0.6, "recentVerbatim": 10, "maxSummaryChars": 3500, "compressAfterMessages": 6}}', NULL, 'llm') ON CONFLICT (id) DO NOTHING;

-- provider_auth_types
INSERT INTO public.provider_auth_types (id, provider_id, name, type, description, token_label, token_placeholder, token_help, sort_order, auth_header) VALUES ('xai:api-key', 'xai', 'API Key', 'api_key', 'Use an xAI API key.', 'API Key', 'xai-…', 'Get your key at console.x.ai → API Keys.', 0, 'Authorization') ON CONFLICT (id) DO NOTHING;

-- seeds/provider-apple-on-device.sql
--
-- Apple on-device foundation-model provider card, auth type, and fixed model
-- row (keyless local runtime, like ollama).

INSERT INTO public.providers (id, name, description, website, api_docs, sort_order, default_metadata, base_url, type) VALUES ('apple-on-device', 'Apple On-Device', 'Apple''s on-device FoundationModels LLM (~3B params). Runs fully locally via a Swift sidecar — no network, no API key. Requires macOS 26+ with Apple Intelligence enabled. 4096-token context window.', 'https://developer.apple.com/documentation/foundationmodels', 'https://developer.apple.com/documentation/foundationmodels', 8, '{"summary": {"maxWords": 300, "messageThreshold": 8}, "contextCompression": {"triggerRatio": 0.6, "recentVerbatim": 6, "maxSummaryChars": 1200, "compressAfterMessages": 4}}', NULL, 'llm') ON CONFLICT (id) DO NOTHING;

-- provider_auth_types
INSERT INTO public.provider_auth_types (id, provider_id, name, type, description, token_label, token_placeholder, token_help, sort_order, auth_header) VALUES ('apple-on-device:none', 'apple-on-device', 'No Auth', 'none', 'Runs Apple''s on-device model locally. No API key is required. Requires macOS 26+ with Apple Intelligence enabled.', NULL, NULL, 'Enable Apple Intelligence in System Settings → Apple Intelligence & Siri. No further setup needed — Snaglet builds and runs the sidecar automatically.', 0, NULL) ON CONFLICT (id) DO NOTHING;

-- models: the single fixed on-device model. Fixed id so a replay (see
-- SEED_REPLAY_FILES) targets the same row.
INSERT INTO public.models (
  id, provider_id, model_id, display_name, description, family,
  context_window_tokens, max_output_tokens, supports_tools, supports_vision,
  supports_reasoning, type, dimensions, sort_order, metadata
) VALUES (
  'model-7ac7667f-c14c-43e4-be58-ea2539966218',
  'apple-on-device',
  'apple-on-device',
  'Apple On-Device (~3B)',
  'Apple''s on-device FoundationModels LLM. Streams via a local Swift sidecar; 4096-token total context window (prompt + completion).',
  'apple-foundation',
  4096,
  1024,
  false,
  false,
  false,
  'llm',
  NULL,
  0,
  '{}'::jsonb
) ON CONFLICT (provider_id, model_id) DO NOTHING;

-- seeds/provider-models.sql
--
-- The cloud provider model catalogs: which models each hosted provider offers,
-- with the context windows and output limits it publishes. Runs last, after
-- every provider card exists (provider-catalog.sql, provider-deepseek.sql,
-- provider-xai.sql), so each row's provider_id FK resolves.
--
-- Why it exists. `contextWindow/budget.ts` uses DEFAULT_CONTEXT_WINDOW (8192)
-- for a model with no catalog row or no window, which leaves an agent about
-- 2.6k tokens of message budget. Discovery writes the catalog only when a
-- credential is saved or tested, so these rows are the floor until then.
--
-- What is in. Nine hosted providers whose model lists are the same for every
-- user: anthropic, openai, codex, copilot, google, mistral, together, xai,
-- deepseek. A limit the provider does not publish is NULL: a NULL max output
-- lets the provider apply its own maximum, and the Codex rows with a NULL
-- window (gpt-6-astra, gpt-6-luna, gpt-6.1-terra) take the default window
-- until discovery or a person sets one.
--
-- What is left out.
--   - `ollama` and `lm-studio`: their models are whatever one machine has
--     installed, so they come from local discovery.
--   - The bundled local runtimes (`snaglet-local`, `local-onnx`,
--     `apple-on-device`): seeded by local-models.sql /
--     provider-snaglet-local.sql / provider-apple-on-device.sql against files
--     the app ships.
--   - Inactive rows: a row is inactive when a person removed it or one
--     account's plan blocks it, so it does not apply to every user.
--
-- `metadata` is `{}`, `{"lifecycle": "deprecated"}` for a model the provider
-- has scheduled for retirement, or `{"lifecycle": "legacy"}` for an older
-- model it still serves. Pickers list deprecated and legacy models after the
-- current ones, and the default suggestion skips them.
--
-- No-resurrect contract. Every statement here is INSERT ... ON CONFLICT DO
-- NOTHING with no conflict target, i.e. strict insert-if-absent: a conflict on
-- either unique constraint (the `id` primary key or `(provider_id, model_id)`)
-- skips the row. Nothing here UPDATEs a models row. Removing a model from the
-- picker is a soft delete: `Models.deactivateByUser` sets `is_active = FALSE`
-- and stamps `metadata.deactivatedBy = 'user'`, and the row stays. An
-- `ON CONFLICT ... DO UPDATE` (what `Models.bulkUpsert` does, which is why
-- `ProviderModelDiscoveryService/persistence.ts` uses it for new rows only)
-- would set `is_active` back to TRUE and drop the stamp, bringing back on
-- every boot the models a person removed. `is_active` is therefore absent from
-- the column list: new rows take the column DEFAULT (TRUE), and existing rows
-- are never touched.
--
-- `id` is the deterministic `<provider_id>:<model_id>`, so replays are stable
-- and a diff of this file reads as model names rather than UUID churn.

-- Anthropic — the Claude family. (18 models)
INSERT INTO public.models (
  id, provider_id, model_id, display_name, description, family,
  context_window_tokens, max_output_tokens, supports_tools, supports_vision,
  supports_reasoning, type, dimensions, sort_order, metadata
) VALUES
  ('anthropic:claude-opus-4-5', 'anthropic', 'claude-opus-4-5', 'Claude Opus 4.5', 'Most capable Claude model — best for complex reasoning and coding.', NULL, 200000, 64000, true, false, false, 'llm', NULL, 0, '{"lifecycle": "legacy"}'::jsonb),
  ('anthropic:claude-opus-4-7', 'anthropic', 'claude-opus-4-7', 'Claude Opus 4.7', 'Anthropic''s most capable model', 'claude-opus', 1000000, 128000, true, true, true, 'llm', NULL, 0, '{"lifecycle": "legacy"}'::jsonb),
  ('anthropic:claude-opus-4-6', 'anthropic', 'claude-opus-4-6', 'Claude Opus 4.6', '', 'claude-opus', 1000000, 128000, true, true, true, 'llm', NULL, 1, '{"lifecycle": "legacy"}'::jsonb),
  ('anthropic:claude-sonnet-4-5', 'anthropic', 'claude-sonnet-4-5', 'Claude Sonnet 4.5', 'Balanced speed and intelligence. Best for most tasks.', NULL, 200000, 16000, true, false, false, 'llm', NULL, 1, '{"lifecycle": "deprecated"}'::jsonb),
  ('anthropic:claude-sonnet-4-6', 'anthropic', 'claude-sonnet-4-6', 'Claude Sonnet 4.6', '', 'claude-sonnet', 1000000, 128000, true, true, false, 'llm', NULL, 2, '{"lifecycle": "legacy"}'::jsonb),
  ('anthropic:claude-haiku-4-5', 'anthropic', 'claude-haiku-4-5', 'Claude Haiku 4.5', '', NULL, 200000, 64000, true, false, false, 'llm', NULL, 5, '{"lifecycle": "legacy"}'::jsonb),
  ('anthropic:claude-fable-5', 'anthropic', 'claude-fable-5', 'Claude Fable 5', '', 'claude', 1000000, 128000, true, true, false, 'llm', NULL, 999, '{}'::jsonb),
  ('anthropic:claude-fable-5-1', 'anthropic', 'claude-fable-5-1', 'Claude Fable 5.1', '', 'claude', 1000000, 128000, true, true, true, 'llm', NULL, 999, '{}'::jsonb),
  ('anthropic:claude-fable-5-2', 'anthropic', 'claude-fable-5-2', 'Claude Fable 5.2', '', 'claude', 1000000, 128000, true, true, true, 'llm', NULL, 999, '{}'::jsonb),
  ('anthropic:claude-haiku-4-5-20251001', 'anthropic', 'claude-haiku-4-5-20251001', 'Claude Haiku 4.5', '', 'claude-haiku', 200000, 64000, true, true, false, 'llm', NULL, 999, '{"lifecycle": "legacy"}'::jsonb),
  ('anthropic:claude-haiku-5-5', 'anthropic', 'claude-haiku-5-5', 'Claude Haiku 5.5', '', 'claude-haiku', 1000000, 128000, true, true, true, 'llm', NULL, 999, '{}'::jsonb),
  ('anthropic:claude-opus-4-5-20251101', 'anthropic', 'claude-opus-4-5-20251101', 'Claude Opus 4.5', '', 'claude-opus', 200000, 64000, true, true, true, 'llm', NULL, 999, '{"lifecycle": "legacy"}'::jsonb),
  ('anthropic:claude-opus-4-8', 'anthropic', 'claude-opus-4-8', 'Claude Opus 4.8', '', 'claude-opus', 1000000, 128000, true, true, true, 'llm', NULL, 999, '{"lifecycle": "legacy"}'::jsonb),
  ('anthropic:claude-opus-5', 'anthropic', 'claude-opus-5', 'Claude Opus 5', '', 'claude-opus', 1000000, 128000, true, true, true, 'llm', NULL, 999, '{}'::jsonb),
  ('anthropic:claude-opus-5-5', 'anthropic', 'claude-opus-5-5', 'Claude Opus 5.5', '', 'claude-opus', 1000000, 128000, true, true, true, 'llm', NULL, 999, '{}'::jsonb),
  ('anthropic:claude-sonnet-4-5-20250929', 'anthropic', 'claude-sonnet-4-5-20250929', 'Claude Sonnet 4.5', '', 'claude-sonnet', 200000, 16000, true, true, false, 'llm', NULL, 999, '{"lifecycle": "deprecated"}'::jsonb),
  ('anthropic:claude-sonnet-5', 'anthropic', 'claude-sonnet-5', 'Claude Sonnet 5', '', 'claude-sonnet', 1000000, 128000, true, true, true, 'llm', NULL, 999, '{}'::jsonb),
  ('anthropic:claude-sonnet-5-5', 'anthropic', 'claude-sonnet-5-5', 'Claude Sonnet 5.5', '', 'claude-sonnet', 1000000, 128000, true, true, true, 'llm', NULL, 999, '{}'::jsonb)
ON CONFLICT DO NOTHING;

-- OpenAI — GPT / o-series. (65 models)
INSERT INTO public.models (
  id, provider_id, model_id, display_name, description, family,
  context_window_tokens, max_output_tokens, supports_tools, supports_vision,
  supports_reasoning, type, dimensions, sort_order, metadata
) VALUES
  ('openai:gpt-4o', 'openai', 'gpt-4o', 'GPT-4o', 'Flagship multimodal model — text, vision, and audio.', 'gpt-4o', 128000, 16384, true, true, false, 'llm', NULL, 0, '{}'::jsonb),
  ('openai:gpt-4o-mini', 'openai', 'gpt-4o-mini', 'GPT-4o Mini', 'Affordable and fast GPT-4o variant for lightweight tasks.', 'gpt-4o', 128000, 16384, true, true, false, 'llm', NULL, 1, '{}'::jsonb),
  ('openai:chat-latest', 'openai', 'chat-latest', 'Chat Latest', '', 'gpt-5', 400000, 128000, true, true, true, 'llm', NULL, 999, '{}'::jsonb),
  ('openai:gpt-4.1', 'openai', 'gpt-4.1', 'GPT-4.1', '', 'gpt-4.1', 1047576, 32768, true, true, false, 'llm', NULL, 999, '{}'::jsonb),
  ('openai:gpt-4.1-2025-04-14', 'openai', 'gpt-4.1-2025-04-14', 'GPT-4.1', '', 'gpt-4.1', 1047576, 32768, true, true, false, 'llm', NULL, 999, '{"lifecycle": "deprecated"}'::jsonb),
  ('openai:gpt-4.1-mini', 'openai', 'gpt-4.1-mini', 'GPT-4.1 Mini', '', 'gpt-4.1', 1047576, 32768, true, true, false, 'llm', NULL, 999, '{}'::jsonb),
  ('openai:gpt-4.1-mini-2025-04-14', 'openai', 'gpt-4.1-mini-2025-04-14', 'GPT-4.1 Mini', '', 'gpt-4.1', 1047576, 32768, true, true, false, 'llm', NULL, 999, '{"lifecycle": "deprecated"}'::jsonb),
  ('openai:gpt-4o-2024-05-13', 'openai', 'gpt-4o-2024-05-13', 'GPT-4o', '', 'gpt-4o', 128000, 16384, true, true, false, 'llm', NULL, 999, '{"lifecycle": "deprecated"}'::jsonb),
  ('openai:gpt-4o-2024-08-06', 'openai', 'gpt-4o-2024-08-06', 'GPT-4o', '', 'gpt-4o', 128000, 16384, true, true, false, 'llm', NULL, 999, '{"lifecycle": "deprecated"}'::jsonb),
  ('openai:gpt-4o-2024-11-20', 'openai', 'gpt-4o-2024-11-20', 'GPT-4o', '', 'gpt-4o', 128000, 16384, true, true, false, 'llm', NULL, 999, '{"lifecycle": "deprecated"}'::jsonb),
  ('openai:gpt-4o-mini-2024-07-18', 'openai', 'gpt-4o-mini-2024-07-18', 'GPT-4o Mini', '', 'gpt-4o', 128000, 16384, true, true, false, 'llm', NULL, 999, '{"lifecycle": "deprecated"}'::jsonb),
  ('openai:gpt-4o-mini-tts', 'openai', 'gpt-4o-mini-tts', 'GPT-4o Mini Tts', '', 'gpt-4o', 128000, 16384, true, true, false, 'llm', NULL, 999, '{}'::jsonb),
  ('openai:gpt-4o-mini-tts-2025-03-20', 'openai', 'gpt-4o-mini-tts-2025-03-20', 'GPT-4o Mini Tts', '', 'gpt-4o', 128000, 16384, true, true, false, 'llm', NULL, 999, '{}'::jsonb),
  ('openai:gpt-4o-mini-tts-2025-12-15', 'openai', 'gpt-4o-mini-tts-2025-12-15', 'GPT-4o Mini Tts', '', 'gpt-4o', 128000, 16384, true, true, false, 'llm', NULL, 999, '{}'::jsonb),
  ('openai:gpt-5', 'openai', 'gpt-5', 'GPT-5', '', 'gpt-5', 400000, 128000, true, true, true, 'llm', NULL, 999, '{"lifecycle": "deprecated"}'::jsonb),
  ('openai:gpt-5-2025-08-07', 'openai', 'gpt-5-2025-08-07', 'GPT-5', '', 'gpt-5', 400000, 128000, true, true, true, 'llm', NULL, 999, '{"lifecycle": "deprecated"}'::jsonb),
  ('openai:gpt-5-mini', 'openai', 'gpt-5-mini', 'GPT-5 Mini', '', 'gpt-5', 400000, 128000, true, true, true, 'llm', NULL, 999, '{"lifecycle": "deprecated"}'::jsonb),
  ('openai:gpt-5-mini-2025-08-07', 'openai', 'gpt-5-mini-2025-08-07', 'GPT-5 Mini', '', 'gpt-5', 400000, 128000, true, true, true, 'llm', NULL, 999, '{"lifecycle": "deprecated"}'::jsonb),
  ('openai:gpt-5-nano', 'openai', 'gpt-5-nano', 'GPT-5 Nano', '', 'gpt-5', 400000, 128000, true, true, true, 'llm', NULL, 999, '{"lifecycle": "deprecated"}'::jsonb),
  ('openai:gpt-5-nano-2025-08-07', 'openai', 'gpt-5-nano-2025-08-07', 'GPT-5 Nano', '', 'gpt-5', 400000, 128000, true, true, true, 'llm', NULL, 999, '{"lifecycle": "deprecated"}'::jsonb),
  ('openai:gpt-5-pro', 'openai', 'gpt-5-pro', 'GPT-5 Pro', '', 'gpt-5', 400000, 128000, true, true, true, 'llm', NULL, 999, '{"lifecycle": "deprecated"}'::jsonb),
  ('openai:gpt-5-pro-2025-10-06', 'openai', 'gpt-5-pro-2025-10-06', 'GPT-5 Pro', '', 'gpt-5', 400000, 128000, true, true, true, 'llm', NULL, 999, '{"lifecycle": "deprecated"}'::jsonb),
  ('openai:gpt-5-search-api', 'openai', 'gpt-5-search-api', 'GPT-5 Search Api', '', 'gpt-5', 400000, 128000, true, true, true, 'llm', NULL, 999, '{}'::jsonb),
  ('openai:gpt-5-search-api-2025-10-14', 'openai', 'gpt-5-search-api-2025-10-14', 'GPT-5 Search Api', '', 'gpt-5', 400000, 128000, true, true, true, 'llm', NULL, 999, '{}'::jsonb),
  ('openai:gpt-5.1', 'openai', 'gpt-5.1', 'GPT-5.1', '', 'gpt-5', 400000, 128000, true, true, true, 'llm', NULL, 999, '{"lifecycle": "deprecated"}'::jsonb),
  ('openai:gpt-5.1-2025-11-13', 'openai', 'gpt-5.1-2025-11-13', 'GPT-5.1', '', 'gpt-5', 400000, 128000, true, true, true, 'llm', NULL, 999, '{"lifecycle": "deprecated"}'::jsonb),
  ('openai:gpt-5.2', 'openai', 'gpt-5.2', 'GPT-5.2', '', 'gpt-5', 400000, 128000, true, true, true, 'llm', NULL, 999, '{"lifecycle": "legacy"}'::jsonb),
  ('openai:gpt-5.2-2025-12-11', 'openai', 'gpt-5.2-2025-12-11', 'GPT-5.2', '', 'gpt-5', 400000, 128000, true, true, true, 'llm', NULL, 999, '{"lifecycle": "legacy"}'::jsonb),
  ('openai:gpt-5.2-pro', 'openai', 'gpt-5.2-pro', 'GPT-5.2 Pro', '', 'gpt-5', 400000, 128000, true, true, true, 'llm', NULL, 999, '{"lifecycle": "legacy"}'::jsonb),
  ('openai:gpt-5.2-pro-2025-12-11', 'openai', 'gpt-5.2-pro-2025-12-11', 'GPT-5.2 Pro', '', 'gpt-5', 400000, 128000, true, true, true, 'llm', NULL, 999, '{"lifecycle": "legacy"}'::jsonb),
  ('openai:gpt-5.3-codex', 'openai', 'gpt-5.3-codex', 'GPT-5.3 Codex', '', 'gpt-5', 400000, 128000, true, true, true, 'llm', NULL, 999, '{"lifecycle": "deprecated"}'::jsonb),
  ('openai:gpt-5.4', 'openai', 'gpt-5.4', 'GPT-5.4', '', 'gpt-5', 1050000, 128000, true, true, true, 'llm', NULL, 999, '{}'::jsonb),
  ('openai:gpt-5.4-2026-03-05', 'openai', 'gpt-5.4-2026-03-05', 'GPT-5.4', '', 'gpt-5', 1050000, 128000, true, true, true, 'llm', NULL, 999, '{}'::jsonb),
  ('openai:gpt-5.4-mini', 'openai', 'gpt-5.4-mini', 'GPT-5.4 Mini', '', 'gpt-5', 400000, 128000, true, true, true, 'llm', NULL, 999, '{}'::jsonb),
  ('openai:gpt-5.4-mini-2026-03-17', 'openai', 'gpt-5.4-mini-2026-03-17', 'GPT-5.4 Mini', '', 'gpt-5', 400000, 128000, true, true, true, 'llm', NULL, 999, '{}'::jsonb),
  ('openai:gpt-5.4-nano', 'openai', 'gpt-5.4-nano', 'GPT-5.4 Nano', '', 'gpt-5', 400000, 128000, true, true, true, 'llm', NULL, 999, '{"lifecycle": "deprecated"}'::jsonb),
  ('openai:gpt-5.4-nano-2026-03-17', 'openai', 'gpt-5.4-nano-2026-03-17', 'GPT-5.4 Nano', '', 'gpt-5', 400000, 128000, true, true, true, 'llm', NULL, 999, '{"lifecycle": "deprecated"}'::jsonb),
  ('openai:gpt-5.4-pro', 'openai', 'gpt-5.4-pro', 'GPT-5.4 Pro', '', 'gpt-5', 1050000, 128000, true, true, true, 'llm', NULL, 999, '{}'::jsonb),
  ('openai:gpt-5.4-pro-2026-03-05', 'openai', 'gpt-5.4-pro-2026-03-05', 'GPT-5.4 Pro', '', 'gpt-5', 1050000, 128000, true, true, true, 'llm', NULL, 999, '{}'::jsonb),
  ('openai:gpt-5.5', 'openai', 'gpt-5.5', 'GPT-5.5', '', 'gpt-5', 1050000, 128000, true, true, true, 'llm', NULL, 999, '{}'::jsonb),
  ('openai:gpt-5.5-2026-04-23', 'openai', 'gpt-5.5-2026-04-23', 'GPT-5.5', '', 'gpt-5', 1050000, 128000, true, true, true, 'llm', NULL, 999, '{}'::jsonb),
  ('openai:gpt-5.5-pro', 'openai', 'gpt-5.5-pro', 'GPT-5.5 Pro', '', 'gpt-5', 1050000, 128000, true, true, true, 'llm', NULL, 999, '{}'::jsonb),
  ('openai:gpt-5.5-pro-2026-04-23', 'openai', 'gpt-5.5-pro-2026-04-23', 'GPT-5.5 Pro', '', 'gpt-5', 1050000, 128000, true, true, true, 'llm', NULL, 999, '{}'::jsonb),
  ('openai:gpt-5.6-luna', 'openai', 'gpt-5.6-luna', 'GPT-5.6 Luna', '', 'gpt-5', 1050000, 128000, true, true, true, 'llm', NULL, 999, '{}'::jsonb),
  ('openai:gpt-5.6-sol', 'openai', 'gpt-5.6-sol', 'GPT-5.6 Sol', '', 'gpt-5', 1050000, 128000, true, true, true, 'llm', NULL, 999, '{}'::jsonb),
  ('openai:gpt-5.6-terra', 'openai', 'gpt-5.6-terra', 'GPT-5.6 Terra', '', 'gpt-5', 1050000, 128000, true, true, true, 'llm', NULL, 999, '{}'::jsonb),
  ('openai:gpt-6-astra', 'openai', 'gpt-6-astra', 'GPT-6 Astra', '', 'gpt-6', 1050000, 128000, true, true, true, 'llm', NULL, 999, '{}'::jsonb),
  ('openai:gpt-6-luna', 'openai', 'gpt-6-luna', 'GPT-6 Luna', '', 'gpt-6', 1050000, 128000, true, true, true, 'llm', NULL, 999, '{}'::jsonb),
  ('openai:gpt-6-sol', 'openai', 'gpt-6-sol', 'GPT-6 Sol', '', 'gpt-6', 1050000, 128000, true, true, true, 'llm', NULL, 999, '{}'::jsonb),
  ('openai:gpt-6.1-sol', 'openai', 'gpt-6.1-sol', 'GPT-6.1 Sol', '', 'gpt-6', 1050000, 128000, true, true, true, 'llm', NULL, 999, '{}'::jsonb),
  ('openai:gpt-6.1-terra', 'openai', 'gpt-6.1-terra', 'GPT-6.1 Terra', '', 'gpt-6', 1050000, 128000, true, true, true, 'llm', NULL, 999, '{}'::jsonb),
  ('openai:gpt-6.2-astra', 'openai', 'gpt-6.2-astra', 'GPT-6.2 Astra', '', 'gpt-6', 1050000, 128000, true, true, true, 'llm', NULL, 999, '{}'::jsonb),
  ('openai:gpt-6.2-sol', 'openai', 'gpt-6.2-sol', 'GPT-6.2 Sol', '', 'gpt-6', 1050000, 128000, true, true, true, 'llm', NULL, 999, '{}'::jsonb),
  ('openai:gpt-audio', 'openai', 'gpt-audio', 'GPT Audio', '', 'openai', 128000, 4096, true, false, false, 'llm', NULL, 999, '{}'::jsonb),
  ('openai:gpt-audio-1.5', 'openai', 'gpt-audio-1.5', 'GPT Audio 1.5', '', 'openai', 128000, 4096, true, false, false, 'llm', NULL, 999, '{}'::jsonb),
  ('openai:gpt-audio-2025-08-28', 'openai', 'gpt-audio-2025-08-28', 'GPT Audio', '', 'openai', 128000, 4096, true, false, false, 'llm', NULL, 999, '{}'::jsonb),
  ('openai:gpt-audio-mini', 'openai', 'gpt-audio-mini', 'GPT Audio Mini', '', 'openai', 128000, 4096, true, false, false, 'llm', NULL, 999, '{}'::jsonb),
  ('openai:gpt-audio-mini-2025-10-06', 'openai', 'gpt-audio-mini-2025-10-06', 'GPT Audio Mini', '', 'openai', 128000, 4096, true, false, false, 'llm', NULL, 999, '{}'::jsonb),
  ('openai:gpt-audio-mini-2025-12-15', 'openai', 'gpt-audio-mini-2025-12-15', 'GPT Audio Mini', '', 'openai', 128000, 4096, true, false, false, 'llm', NULL, 999, '{}'::jsonb),
  ('openai:gpt-oss-120b', 'openai', 'gpt-oss-120b', 'GPT-OSS 120B', '', 'gpt-oss', 131072, 131072, true, false, true, 'llm', NULL, 999, '{}'::jsonb),
  ('openai:gpt-oss-20b', 'openai', 'gpt-oss-20b', 'GPT-OSS 20B', '', 'gpt-oss', 131072, 131072, true, false, true, 'llm', NULL, 999, '{}'::jsonb),
  ('openai:o3', 'openai', 'o3', 'o3', '', 'o3', 200000, 100000, true, true, true, 'llm', NULL, 999, '{"lifecycle": "deprecated"}'::jsonb),
  ('openai:o3-2025-04-16', 'openai', 'o3-2025-04-16', 'o3', '', 'o3', 200000, 100000, true, true, true, 'llm', NULL, 999, '{"lifecycle": "deprecated"}'::jsonb),
  ('openai:o3-pro', 'openai', 'o3-pro', 'o3 Pro', '', 'o3', 200000, 100000, true, true, true, 'llm', NULL, 999, '{"lifecycle": "deprecated"}'::jsonb),
  ('openai:o3-pro-2025-06-10', 'openai', 'o3-pro-2025-06-10', 'o3 Pro', '', 'o3', 200000, 100000, true, true, true, 'llm', NULL, 999, '{"lifecycle": "deprecated"}'::jsonb)
ON CONFLICT DO NOTHING;

-- OpenAI Codex — the coding-focused slice of OpenAI's catalog. (12 models)
INSERT INTO public.models (
  id, provider_id, model_id, display_name, description, family,
  context_window_tokens, max_output_tokens, supports_tools, supports_vision,
  supports_reasoning, type, dimensions, sort_order, metadata
) VALUES
  ('codex:gpt-6-astra', 'codex', 'gpt-6-astra', 'GPT-6 Astra', 'Complex reasoning and coding; standard Codex context window', 'gpt-6', NULL, 128000, true, true, true, 'llm', NULL, -1, '{}'::jsonb),
  ('codex:gpt-6.1-sol', 'codex', 'gpt-6.1-sol', 'GPT-6.1 Sol', 'Coding and everyday work; standard Codex context window', 'gpt-6', 500000, 128000, true, true, true, 'llm', NULL, -1, '{}'::jsonb),
  ('codex:gpt-5.3-codex', 'codex', 'gpt-5.3-codex', 'GPT-5.3 Codex', 'Core Codex model', 'gpt-5', 400000, 128000, true, true, true, 'llm', NULL, 3, '{"lifecycle": "deprecated"}'::jsonb),
  ('codex:gpt-5.2', 'codex', 'gpt-5.2', 'GPT-5.2', 'Core Codex model', 'gpt-5', 400000, 128000, true, true, true, 'llm', NULL, 5, '{"lifecycle": "deprecated"}'::jsonb),
  ('codex:codex-latest', 'codex', 'codex-latest', 'Codex Latest (rolling)', 'Rolling alias for latest Codex model', 'alias', 400000, 128000, true, true, true, 'llm', NULL, 9, '{}'::jsonb),
  ('codex:gpt-5.6-luna', 'codex', 'gpt-5.6-luna', 'gpt-5.6-luna', '', NULL, 372000, 128000, true, true, false, 'llm', NULL, 999, '{}'::jsonb),
  ('codex:gpt-5.6-sol', 'codex', 'gpt-5.6-sol', 'GPT-5.6 Sol', '', NULL, 372000, 128000, true, true, false, 'llm', NULL, 999, '{}'::jsonb),
  ('codex:gpt-5.6-terra', 'codex', 'gpt-5.6-terra', 'GPT 5.6 Terra', '', NULL, 372000, 128000, true, true, false, 'llm', NULL, 999, '{}'::jsonb),
  ('codex:gpt-6-luna', 'codex', 'gpt-6-luna', 'GPT-6 Luna', '', 'gpt-6', NULL, NULL, true, true, true, 'llm', NULL, 999, '{}'::jsonb),
  ('codex:gpt-6.1-terra', 'codex', 'gpt-6.1-terra', 'GPT-6.1 Terra', '', 'gpt-6', NULL, NULL, true, true, true, 'llm', NULL, 999, '{}'::jsonb),
  ('codex:gpt-6.2-astra', 'codex', 'gpt-6.2-astra', 'GPT-6.2 Astra', '', 'gpt-6', 272000, NULL, true, true, true, 'llm', NULL, 999, '{}'::jsonb),
  ('codex:gpt-6.2-sol', 'codex', 'gpt-6.2-sol', 'GPT-6.2 Sol', '', 'gpt-6', 500000, NULL, true, true, true, 'llm', NULL, 999, '{}'::jsonb)
ON CONFLICT DO NOTHING;

-- GitHub Copilot — multi-vendor models fronted by the Copilot API. (30 models)
INSERT INTO public.models (
  id, provider_id, model_id, display_name, description, family,
  context_window_tokens, max_output_tokens, supports_tools, supports_vision,
  supports_reasoning, type, dimensions, sort_order, metadata
) VALUES
  ('copilot:gpt-4.1', 'copilot', 'gpt-4.1', 'GPT-4.1', 'General-purpose coding and writing', 'gpt-4', 1047576, 32768, true, true, false, 'llm', NULL, 0, '{}'::jsonb),
  ('copilot:gpt-4o', 'copilot', 'gpt-4o', 'GPT-4o', 'OpenAI GPT-4o via Copilot', 'gpt-4o', 128000, NULL, true, true, false, 'llm', NULL, 0, '{}'::jsonb),
  ('copilot:gpt-4o-mini', 'copilot', 'gpt-4o-mini', 'GPT-4o mini', 'OpenAI GPT-4o mini via Copilot', 'gpt-4o', 128000, NULL, true, false, false, 'llm', NULL, 1, '{}'::jsonb),
  ('copilot:gpt-5-mini', 'copilot', 'gpt-5-mini', 'GPT-5 mini', 'Reliable default for coding, writing, and multimodal', 'gpt-5-mini', 264000, 64000, true, true, false, 'llm', NULL, 1, '{}'::jsonb),
  ('copilot:gpt-5.3-codex', 'copilot', 'gpt-5.3-codex', 'GPT-5.3-Codex', 'Agentic software development', 'gpt-5.3-codex', 400000, 128000, true, true, false, 'llm', NULL, 5, '{}'::jsonb),
  ('copilot:gpt-5.4', 'copilot', 'gpt-5.4', 'GPT-5.4', 'Complex reasoning, code analysis, and technical decisions', 'gpt-5.4', 400000, 128000, true, true, false, 'llm', NULL, 6, '{}'::jsonb),
  ('copilot:gpt-5.4-mini', 'copilot', 'gpt-5.4-mini', 'GPT-5.4 mini', 'Codebase exploration, grep-style tools', 'gpt-5.4-mini', 400000, 128000, true, true, false, 'llm', NULL, 7, '{}'::jsonb),
  ('copilot:claude-haiku-4.5', 'copilot', 'claude-haiku-4.5', 'Claude Haiku 4.5', 'Fast, reliable answers to lightweight coding questions', 'claude-haiku-4.5', 200000, 32000, true, true, false, 'llm', NULL, 10, '{}'::jsonb),
  ('copilot:claude-opus-4.5', 'copilot', 'claude-opus-4.5', 'Claude Opus 4.5', 'Complex problem-solving, sophisticated reasoning', 'claude-opus-4.5', 200000, 32000, true, true, false, 'llm', NULL, 11, '{}'::jsonb),
  ('copilot:claude-opus-4.6', 'copilot', 'claude-opus-4.6', 'Claude Opus 4.6', 'Anthropic''s most powerful model, improves on Opus 4.5', 'claude', 200000, 16000, true, true, true, 'llm', NULL, 12, '{}'::jsonb),
  ('copilot:claude-opus-4.6-fast', 'copilot', 'claude-opus-4.6-fast', 'Claude Opus 4.6 (fast mode)', 'Opus 4.6 fast mode preview — 30x multiplier', 'claude', 200000, 16000, true, true, true, 'llm', NULL, 13, '{}'::jsonb),
  ('copilot:claude-sonnet-4.5', 'copilot', 'claude-sonnet-4.5', 'Claude Sonnet 4.5', 'Complex problem-solving, sophisticated reasoning', 'claude-sonnet-4.5', 200000, 32000, true, true, false, 'llm', NULL, 15, '{}'::jsonb),
  ('copilot:claude-sonnet-4.6', 'copilot', 'claude-sonnet-4.6', 'Claude Sonnet 4.6', 'Reliable completions and smarter reasoning under pressure', 'claude-sonnet-4.6', 264000, 64000, true, true, false, 'llm', NULL, 16, '{}'::jsonb),
  ('copilot:gemini-2.5-pro', 'copilot', 'gemini-2.5-pro', 'Gemini 2.5 Pro', 'Complex code generation, debugging, and research', 'gemini-2.5-pro', 128000, 64000, true, true, false, 'llm', NULL, 20, '{}'::jsonb),
  ('copilot:Grok-3', 'copilot', 'Grok-3', 'Grok 3', 'xAI Grok 3 via Copilot', 'grok', 131072, NULL, true, false, false, 'llm', NULL, 21, '{}'::jsonb),
  ('copilot:claude-fable-5', 'copilot', 'claude-fable-5', 'Claude Fable 5', '', 'claude-fable-5', 264000, 64000, true, true, false, 'llm', NULL, 999, '{}'::jsonb),
  ('copilot:claude-opus-4.7', 'copilot', 'claude-opus-4.7', 'Claude Opus 4.7', '', 'claude-opus-4.7', 264000, 64000, true, true, false, 'llm', NULL, 999, '{}'::jsonb),
  ('copilot:claude-opus-4.8', 'copilot', 'claude-opus-4.8', 'Claude Opus 4.8', '', 'claude-opus-4.8', 264000, 64000, true, true, false, 'llm', NULL, 999, '{}'::jsonb),
  ('copilot:claude-opus-4.8-fast', 'copilot', 'claude-opus-4.8-fast', 'Claude Opus 4.8 (fast mode)', '', 'claude-opus-4.8-fast', 264000, 64000, true, true, false, 'llm', NULL, 999, '{}'::jsonb),
  ('copilot:claude-sonnet-5', 'copilot', 'claude-sonnet-5', 'Claude Sonnet 5', '', 'claude-sonnet-5', 264000, 64000, true, true, false, 'llm', NULL, 999, '{}'::jsonb),
  ('copilot:gemini-3-flash-preview', 'copilot', 'gemini-3-flash-preview', 'Gemini 3 Flash (Preview)', '', 'gemini-3-flash', 128000, 64000, true, true, false, 'llm', NULL, 999, '{}'::jsonb),
  ('copilot:gemini-3.1-pro-preview', 'copilot', 'gemini-3.1-pro-preview', 'Gemini 3.1 Pro', '', 'gemini-3.1-pro-preview', 264000, 64000, true, true, false, 'llm', NULL, 999, '{}'::jsonb),
  ('copilot:gemini-3.5-flash', 'copilot', 'gemini-3.5-flash', 'Gemini 3.5 Flash', '', 'gemini-3.5-flash', 264000, 64000, true, true, false, 'llm', NULL, 999, '{}'::jsonb),
  ('copilot:gpt-5.5', 'copilot', 'gpt-5.5', 'GPT-5.5', '', 'gpt-5.5', 400000, 128000, true, true, false, 'llm', NULL, 999, '{}'::jsonb),
  ('copilot:gpt-5.6-luna', 'copilot', 'gpt-5.6-luna', 'GPT-5.6 Luna', '', 'gpt-5.6-luna', 328000, 128000, true, true, false, 'llm', NULL, 999, '{}'::jsonb),
  ('copilot:gpt-5.6-sol', 'copilot', 'gpt-5.6-sol', 'GPT-5.6 Sol', '', 'gpt-5.6-sol', 400000, 128000, true, true, false, 'llm', NULL, 999, '{}'::jsonb),
  ('copilot:gpt-5.6-terra', 'copilot', 'gpt-5.6-terra', 'GPT-5.6 Terra', '', 'gpt-5.6-terra', 400000, 128000, true, true, false, 'llm', NULL, 999, '{}'::jsonb),
  ('copilot:kimi-k2.7-code', 'copilot', 'kimi-k2.7-code', 'Kimi K2.7 Code', '', 'kimi-k2.7-code', 256000, 32000, true, true, false, 'llm', NULL, 999, '{}'::jsonb),
  ('copilot:mai-code-1-flash-picker', 'copilot', 'mai-code-1-flash-picker', 'MAI-Code-1-Flash', '', 'oswe-vscode-modelD', 256000, 128000, true, false, false, 'llm', NULL, 999, '{}'::jsonb),
  ('copilot:oswe-vscode-prime', 'copilot', 'oswe-vscode-prime', 'Raptor mini', '', 'oswe-vscode', 264000, 64000, true, true, false, 'llm', NULL, 999, '{}'::jsonb)
ON CONFLICT DO NOTHING;

-- Google — Gemini. (14 models)
INSERT INTO public.models (
  id, provider_id, model_id, display_name, description, family,
  context_window_tokens, max_output_tokens, supports_tools, supports_vision,
  supports_reasoning, type, dimensions, sort_order, metadata
) VALUES
  ('google:gemini-2.0-pro', 'google', 'gemini-2.0-pro', 'Gemini 2.0 Pro', 'Most capable Gemini 2.0 model for complex tasks.', NULL, 2000000, NULL, true, false, false, 'llm', NULL, 1, '{}'::jsonb),
  ('google:gemini-1.5-pro', 'google', 'gemini-1.5-pro', 'Gemini 1.5 Pro', 'Long context model with strong reasoning.', NULL, 2000000, NULL, true, false, false, 'llm', NULL, 2, '{}'::jsonb),
  ('google:gemini-1.5-flash', 'google', 'gemini-1.5-flash', 'Gemini 1.5 Flash', 'Fast and versatile multimodal model.', NULL, 1000000, NULL, true, false, false, 'llm', NULL, 3, '{}'::jsonb),
  ('google:gemini-3-flash-preview', 'google', 'gemini-3-flash-preview', 'Gemini 3 Flash Preview', '', NULL, 1048576, 65536, true, false, false, 'llm', NULL, 999, '{}'::jsonb),
  ('google:gemini-3.1-flash-lite', 'google', 'gemini-3.1-flash-lite', 'Gemini 3.1 Flash Lite', '', NULL, 1048576, 65536, true, false, false, 'llm', NULL, 999, '{}'::jsonb),
  ('google:gemini-3.1-pro-preview', 'google', 'gemini-3.1-pro-preview', 'Gemini 3.1 Pro Preview', '', NULL, 1048576, 65536, true, false, false, 'llm', NULL, 999, '{}'::jsonb),
  ('google:gemini-3.1-pro-preview-customtools', 'google', 'gemini-3.1-pro-preview-customtools', 'Gemini 3.1 Pro Preview (custom tools)', '', NULL, 1048576, 65536, true, false, false, 'llm', NULL, 999, '{}'::jsonb),
  ('google:gemini-3.5-flash-lite', 'google', 'gemini-3.5-flash-lite', 'Gemini 3.5 Flash Lite', '', NULL, 1048576, 65536, true, false, false, 'llm', NULL, 999, '{}'::jsonb),
  ('google:gemini-3.6-flash', 'google', 'gemini-3.6-flash', 'Gemini 3.6 Flash', '', NULL, 1048576, 65536, true, false, false, 'llm', NULL, 999, '{}'::jsonb),
  ('google:gemini-3.8-flash', 'google', 'gemini-3.8-flash', 'Gemini 3.8 Flash', '', NULL, 1048576, 65536, true, false, true, 'llm', NULL, 999, '{}'::jsonb),
  ('google:gemini-4-argon', 'google', 'gemini-4-argon', 'Gemini 4 Argon', '', NULL, 1048576, 65536, true, false, true, 'llm', NULL, 999, '{}'::jsonb),
  ('google:gemini-4-carbon', 'google', 'gemini-4-carbon', 'Gemini 4 Carbon', '', NULL, 1048576, 65536, true, false, true, 'llm', NULL, 999, '{}'::jsonb),
  ('google:gemini-4-hydrogen', 'google', 'gemini-4-hydrogen', 'Gemini 4 Hydrogen', '', NULL, 1048576, 65536, true, false, true, 'llm', NULL, 999, '{}'::jsonb),
  ('google:gemini-4-neon', 'google', 'gemini-4-neon', 'Gemini 4 Neon', '', NULL, 1048576, 65536, true, false, true, 'llm', NULL, 999, '{}'::jsonb)
ON CONFLICT DO NOTHING;

-- Mistral AI. (37 models)
INSERT INTO public.models (
  id, provider_id, model_id, display_name, description, family,
  context_window_tokens, max_output_tokens, supports_tools, supports_vision,
  supports_reasoning, type, dimensions, sort_order, metadata
) VALUES
  ('mistral:mistral-large-latest', 'mistral', 'mistral-large-latest', 'Mistral Large 4', 'Official mistral-large-2512 Mistral AI model', 'mistral-large', 1000000, NULL, true, true, false, 'llm', NULL, 0, '{}'::jsonb),
  ('mistral:open-mistral-7b', 'mistral', 'open-mistral-7b', 'Mistral 7B', 'Lightweight open model for simple tasks', 'mistral-7b', 32768, 4096, true, false, false, 'llm', NULL, 0, '{}'::jsonb),
  ('mistral:open-mixtral-8x7b', 'mistral', 'open-mixtral-8x7b', 'Mixtral 8x7B', 'Open mixture-of-experts model', 'mixtral', 32768, 4096, true, false, false, 'llm', NULL, 1, '{}'::jsonb),
  ('mistral:codestral-latest', 'mistral', 'codestral-latest', 'codestral-2508', 'Our cutting-edge language model for coding released August 2025.', 'codestral', 128000, NULL, true, false, false, 'llm', NULL, 2, '{}'::jsonb),
  ('mistral:open-mixtral-8x22b', 'mistral', 'open-mixtral-8x22b', 'Mixtral 8x22B', 'Most capable open mixture-of-experts model', 'mixtral', 65536, 4096, true, false, false, 'llm', NULL, 2, '{}'::jsonb),
  ('mistral:mistral-small-latest', 'mistral', 'mistral-small-latest', 'mistral-small-2603', 'Mistral Small 4.', 'mistral-small', 262144, 4096, true, true, false, 'llm', NULL, 3, '{}'::jsonb),
  ('mistral:mistral-medium-latest', 'mistral', 'mistral-medium-latest', 'mistral-medium-2508', 'Update on Mistral Medium 3 with improved capabilities.', 'mistral-medium', 131072, 4096, true, true, false, 'llm', NULL, 4, '{"lifecycle": "deprecated"}'::jsonb),
  ('mistral:codestral-2508', 'mistral', 'codestral-2508', 'codestral-2508', 'Our cutting-edge language model for coding released August 2025.', 'codestral', 128000, NULL, true, false, false, 'llm', NULL, 999, '{}'::jsonb),
  ('mistral:deepseek-v4-1-flash-1017', 'mistral', 'deepseek-v4-1-flash-1017', 'DeepSeek V4.1 Flash 1017', '', 'mistral', 1000000, NULL, true, false, false, 'llm', NULL, 999, '{}'::jsonb),
  ('mistral:devstral-latest', 'mistral', 'devstral-latest', 'devstral-2512', 'Official devstral-2512 Mistral AI model', 'mistral', 262144, NULL, true, false, false, 'llm', NULL, 999, '{}'::jsonb),
  ('mistral:devstral-medium-latest', 'mistral', 'devstral-medium-latest', 'devstral-2512', 'Official devstral-2512 Mistral AI model', 'mistral', 262144, NULL, true, false, false, 'llm', NULL, 999, '{}'::jsonb),
  ('mistral:labs-leanstral-2603', 'mistral', 'labs-leanstral-2603', 'labs-leanstral-2603', 'A mid & post-trained version of mistral small 4 for Lean', 'mistral', 196608, NULL, true, true, false, 'llm', NULL, 999, '{}'::jsonb),
  ('mistral:magistral-medium-latest', 'mistral', 'magistral-medium-latest', 'magistral-medium-2509', 'Our frontier-class reasoning model release candidate September 2025.', 'magistral', 131072, NULL, true, true, true, 'llm', NULL, 999, '{}'::jsonb),
  ('mistral:magistral-small-latest', 'mistral', 'magistral-small-latest', 'mistral-small-2603', 'Mistral Small 4.', 'magistral', 262144, NULL, true, true, true, 'llm', NULL, 999, '{}'::jsonb),
  ('mistral:ministral-14b-2512', 'mistral', 'ministral-14b-2512', 'ministral-14b-2512', 'Ministral 3 (a.k.a. Tinystral) 14B Instruct.', 'ministral', 262144, NULL, true, true, false, 'llm', NULL, 999, '{}'::jsonb),
  ('mistral:ministral-14b-latest', 'mistral', 'ministral-14b-latest', 'ministral-14b-2512', 'Ministral 3 (a.k.a. Tinystral) 14B Instruct.', 'ministral', 262144, NULL, true, true, false, 'llm', NULL, 999, '{}'::jsonb),
  ('mistral:ministral-3b-2512', 'mistral', 'ministral-3b-2512', 'ministral-3b-2512', 'Ministral 3 (a.k.a. Tinystral) 3B Instruct.', 'ministral', 262144, NULL, true, true, false, 'llm', NULL, 999, '{}'::jsonb),
  ('mistral:ministral-3b-latest', 'mistral', 'ministral-3b-latest', 'ministral-3b-2512', 'Ministral 3 (a.k.a. Tinystral) 3B Instruct.', 'ministral', 262144, NULL, true, true, false, 'llm', NULL, 999, '{}'::jsonb),
  ('mistral:ministral-8b-2512', 'mistral', 'ministral-8b-2512', 'ministral-8b-2512', 'Ministral 3 (a.k.a. Tinystral) 8B Instruct.', 'ministral', 262144, NULL, true, true, false, 'llm', NULL, 999, '{}'::jsonb),
  ('mistral:ministral-8b-latest', 'mistral', 'ministral-8b-latest', 'ministral-8b-2512', 'Ministral 3 (a.k.a. Tinystral) 8B Instruct.', 'ministral', 262144, NULL, true, true, false, 'llm', NULL, 999, '{}'::jsonb),
  ('mistral:mistral-large-2512', 'mistral', 'mistral-large-2512', 'mistral-large-2512', 'Official mistral-large-2512 Mistral AI model', 'mistral-large', 262144, NULL, true, true, false, 'llm', NULL, 999, '{"lifecycle": "deprecated"}'::jsonb),
  ('mistral:mistral-large-4', 'mistral', 'mistral-large-4', 'Mistral Large 4', '', 'mistral-large', 1000000, NULL, true, true, false, 'llm', NULL, 999, '{}'::jsonb),
  ('mistral:mistral-large-4-0', 'mistral', 'mistral-large-4-0', 'Mistral Large 4', '', 'mistral-large', 1000000, NULL, true, true, false, 'llm', NULL, 999, '{}'::jsonb),
  ('mistral:mistral-medium', 'mistral', 'mistral-medium', 'mistral-medium-2508', 'Update on Mistral Medium 3 with improved capabilities.', 'mistral-medium', 131072, NULL, true, true, false, 'llm', NULL, 999, '{}'::jsonb),
  ('mistral:mistral-small-2603', 'mistral', 'mistral-small-2603', 'mistral-small-2603', 'Mistral Small 4.', 'mistral-small', 262144, NULL, true, true, false, 'llm', NULL, 999, '{}'::jsonb),
  ('mistral:mistral-tiny-2407', 'mistral', 'mistral-tiny-2407', 'open-mistral-nemo', 'Our best multilingual open source model released July 2024.', 'mistral', 131072, NULL, true, false, false, 'llm', NULL, 999, '{}'::jsonb),
  ('mistral:mistral-tiny-latest', 'mistral', 'mistral-tiny-latest', 'open-mistral-nemo', 'Our best multilingual open source model released July 2024.', 'mistral', 131072, NULL, true, false, false, 'llm', NULL, 999, '{}'::jsonb),
  ('mistral:mistral-vibe-cli-fast', 'mistral', 'mistral-vibe-cli-fast', 'mistral-small-2603', 'Mistral Small 4.', 'mistral', 262144, NULL, true, true, false, 'llm', NULL, 999, '{}'::jsonb),
  ('mistral:mistral-vibe-cli-latest', 'mistral', 'mistral-vibe-cli-latest', 'mistral-medium-3-5', 'Official mistral-medium-3-5 Mistral AI model', 'mistral', 262144, NULL, true, true, false, 'llm', NULL, 999, '{}'::jsonb),
  ('mistral:mistral-vibe-cli-with-tools', 'mistral', 'mistral-vibe-cli-with-tools', 'mistral-medium-2508', 'Update on Mistral Medium 3 with improved capabilities.', 'mistral', 131072, NULL, true, true, false, 'llm', NULL, 999, '{}'::jsonb),
  ('mistral:open-mistral-nemo', 'mistral', 'open-mistral-nemo', 'open-mistral-nemo', 'Our best multilingual open source model released July 2024.', 'mistral', 131072, NULL, true, false, false, 'llm', NULL, 999, '{}'::jsonb),
  ('mistral:voxtral-small-2507', 'mistral', 'voxtral-small-2507', 'voxtral-small-2507', 'A small audio understanding model released in July 2025', 'mistral', 32768, NULL, true, false, false, 'llm', NULL, 999, '{}'::jsonb),
  ('mistral:voxtral-small-latest', 'mistral', 'voxtral-small-latest', 'voxtral-small-2507', 'A small audio understanding model released in July 2025', 'mistral', 32768, NULL, true, false, false, 'llm', NULL, 999, '{}'::jsonb),
  ('mistral:zai-glm-5', 'mistral', 'zai-glm-5', 'Z.ai GLM 5.3', '', 'mistral', 1000000, NULL, true, false, false, 'llm', NULL, 999, '{}'::jsonb),
  ('mistral:zai-glm-5-3', 'mistral', 'zai-glm-5-3', 'Z.ai GLM 5.3', '', 'mistral', 1000000, NULL, true, false, false, 'llm', NULL, 999, '{}'::jsonb),
  ('mistral:zai-glm-5-3-flash', 'mistral', 'zai-glm-5-3-flash', 'GLM 5.3 Flash', '', 'mistral', 1000000, NULL, true, false, false, 'llm', NULL, 999, '{}'::jsonb),
  ('mistral:zai-glm-latest', 'mistral', 'zai-glm-latest', 'Z.ai GLM 5.3', '', 'mistral', 1000000, NULL, true, false, false, 'llm', NULL, 999, '{}'::jsonb)
ON CONFLICT DO NOTHING;

-- Together AI — hosted open-weight models. (171 models)
INSERT INTO public.models (
  id, provider_id, model_id, display_name, description, family,
  context_window_tokens, max_output_tokens, supports_tools, supports_vision,
  supports_reasoning, type, dimensions, sort_order, metadata
) VALUES
  ('together:Hcompany/Holo3-35B-A3B', 'together', 'Hcompany/Holo3-35B-A3B', 'Holo3 35B A3b', '', 'hcompany', 262144, NULL, false, false, false, 'llm', NULL, 999, '{}'::jsonb),
  ('together:LiquidAI/LFM2-24B-A2B', 'together', 'LiquidAI/LFM2-24B-A2B', 'LFM2-24B-A2B', '', 'togethercomputer', 32768, NULL, false, false, false, 'llm', NULL, 999, '{}'::jsonb),
  ('together:LiquidAI/LFM2.5-8B-A1B', 'together', 'LiquidAI/LFM2.5-8B-A1B', 'LFM2.5-8B-A1B', '', 'liquidai', 128000, NULL, false, false, false, 'llm', NULL, 999, '{}'::jsonb),
  ('together:MiniMaxAI/MiniMax-M1-40k', 'together', 'MiniMaxAI/MiniMax-M1-40k', 'Minimax M1 40K', '', 'minimaxai', 1048576, NULL, false, false, false, 'llm', NULL, 999, '{}'::jsonb),
  ('together:MiniMaxAI/MiniMax-M1-80k', 'together', 'MiniMaxAI/MiniMax-M1-80k', 'Minimax M1 80K', '', 'minimaxai', 1048576, NULL, false, false, false, 'llm', NULL, 999, '{}'::jsonb),
  ('together:MiniMaxAI/MiniMax-M2', 'together', 'MiniMaxAI/MiniMax-M2', 'MiniMax M2', '', 'minimaxai', 196608, NULL, false, false, false, 'llm', NULL, 999, '{}'::jsonb),
  ('together:MiniMaxAI/MiniMax-M2.5-FP4', 'together', 'MiniMaxAI/MiniMax-M2.5-FP4', 'MiniMax M2.5 FP4', '', 'minimaxai', 8192, NULL, false, false, false, 'llm', NULL, 999, '{}'::jsonb),
  ('together:MiniMaxAI/MiniMax-M2.7', 'together', 'MiniMaxAI/MiniMax-M2.7', 'MiniMax M2.7 FP4', '', 'minimaxai', 196608, NULL, false, false, false, 'llm', NULL, 999, '{}'::jsonb),
  ('together:MiniMaxAI/MiniMax-M3', 'together', 'MiniMaxAI/MiniMax-M3', 'MiniMax M3', '', 'minimaxai', 524288, NULL, false, false, false, 'llm', NULL, 999, '{}'::jsonb),
  ('together:NousResearch/Nous-Hermes-2-Mixtral-8x7B-DPO', 'together', 'NousResearch/Nous-Hermes-2-Mixtral-8x7B-DPO', 'Nous Hermes 2 Mixtral 8X7B Dpo', '', 'mixtral', 32768, NULL, true, false, false, 'llm', NULL, 999, '{}'::jsonb),
  ('together:Prism-ML/Ternary-Bonsai-27B', 'together', 'Prism-ML/Ternary-Bonsai-27B', 'Ternary Bonsai 27B', '', 'prism ml', 262144, NULL, false, false, false, 'llm', NULL, 999, '{}'::jsonb),
  ('together:Qwen/QwQ-32B', 'together', 'Qwen/QwQ-32B', 'Qwen QwQ-32B', '', 'qwq', 131072, NULL, true, false, true, 'llm', NULL, 999, '{}'::jsonb),
  ('together:Qwen/Qwen2-1.5B-Instruct', 'together', 'Qwen/Qwen2-1.5B-Instruct', 'Qwen 2 Instruct (1.5B)', '', 'qwen-2', 32768, NULL, false, false, false, 'llm', NULL, 999, '{}'::jsonb),
  ('together:Qwen/Qwen2-72B-Instruct', 'together', 'Qwen/Qwen2-72B-Instruct', 'Qwen2 72B Instruct', '', 'qwen-2', 32768, NULL, false, false, false, 'llm', NULL, 999, '{}'::jsonb),
  ('together:Qwen/Qwen2-VL-72B-Instruct', 'together', 'Qwen/Qwen2-VL-72B-Instruct', 'Qwen2-VL (72B) Instruct', '', 'qwen-2', 32768, NULL, false, true, false, 'llm', NULL, 999, '{}'::jsonb),
  ('together:Qwen/Qwen2.5-1.5B', 'together', 'Qwen/Qwen2.5-1.5B', 'Qwen2.5 1.5B', '', 'qwen-2.5', 131072, NULL, true, false, false, 'llm', NULL, 999, '{}'::jsonb),
  ('together:Qwen/Qwen2.5-1.5B-Instruct', 'together', 'Qwen/Qwen2.5-1.5B-Instruct', 'Qwen2.5 1.5B Instruct', '', 'qwen-2.5', 32768, NULL, true, false, false, 'llm', NULL, 999, '{}'::jsonb),
  ('together:Qwen/Qwen2.5-14B', 'together', 'Qwen/Qwen2.5-14B', 'Qwen2.5 14B', '', 'qwen-2.5', 131072, NULL, true, false, false, 'llm', NULL, 999, '{}'::jsonb),
  ('together:Qwen/Qwen2.5-14B-Instruct', 'together', 'Qwen/Qwen2.5-14B-Instruct', 'Qwen 2.5 14B Instruct', '', 'qwen-2.5', 32768, NULL, true, false, false, 'llm', NULL, 999, '{}'::jsonb),
  ('together:Qwen/Qwen2.5-32B', 'together', 'Qwen/Qwen2.5-32B', 'Qwen2.5 32B', '', 'qwen-2.5', 131072, NULL, true, false, false, 'llm', NULL, 999, '{}'::jsonb),
  ('together:Qwen/Qwen2.5-32B-Instruct', 'together', 'Qwen/Qwen2.5-32B-Instruct', 'Qwen2.5 32B Instruct', '', 'qwen-2.5', 32768, NULL, true, false, false, 'llm', NULL, 999, '{}'::jsonb),
  ('together:Qwen/Qwen2.5-3B-Instruct', 'together', 'Qwen/Qwen2.5-3B-Instruct', 'Qwen2.5 3B Instruct', '', 'qwen-2.5', 32768, NULL, true, false, false, 'llm', NULL, 999, '{}'::jsonb),
  ('together:Qwen/Qwen2.5-72B', 'together', 'Qwen/Qwen2.5-72B', 'Qwen2.5 72B', '', 'qwen-2.5', 131072, NULL, true, false, false, 'llm', NULL, 999, '{}'::jsonb),
  ('together:Qwen/Qwen2.5-72B-Instruct', 'together', 'Qwen/Qwen2.5-72B-Instruct', 'Qwen2.5 72B Instruct', '', 'qwen-2.5', 32768, NULL, true, false, false, 'llm', NULL, 999, '{}'::jsonb),
  ('together:Qwen/Qwen2.5-72B-Instruct-Turbo', 'together', 'Qwen/Qwen2.5-72B-Instruct-Turbo', 'Qwen2.5 72B Instruct Turbo', '', 'qwen-2.5', 131072, NULL, true, false, false, 'llm', NULL, 999, '{}'::jsonb),
  ('together:Qwen/Qwen2.5-7B', 'together', 'Qwen/Qwen2.5-7B', 'Qwen2.5 7B', '', 'qwen-2.5', 131072, NULL, true, false, false, 'llm', NULL, 999, '{}'::jsonb),
  ('together:Qwen/Qwen2.5-7B-Instruct', 'together', 'Qwen/Qwen2.5-7B-Instruct', 'Qwen2.5 7B Instruct', '', 'qwen-2.5', 32768, NULL, true, false, false, 'llm', NULL, 999, '{}'::jsonb),
  ('together:Qwen/Qwen2.5-7B-Instruct-Turbo', 'together', 'Qwen/Qwen2.5-7B-Instruct-Turbo', 'Qwen2.5 7B Instruct Turbo', '', 'qwen-2.5', 32768, NULL, true, false, false, 'llm', NULL, 999, '{}'::jsonb),
  ('together:Qwen/Qwen2.5-Coder-32B-Instruct', 'together', 'Qwen/Qwen2.5-Coder-32B-Instruct', 'Qwen 2.5 Coder 32B Instruct', '', 'qwen-2.5', 16384, NULL, true, false, false, 'llm', NULL, 999, '{}'::jsonb),
  ('together:Qwen/Qwen2.5-VL-72B-Instruct', 'together', 'Qwen/Qwen2.5-VL-72B-Instruct', 'Qwen2.5-VL (72B) Instruct', '', 'qwen-2.5', 32768, NULL, true, true, false, 'llm', NULL, 999, '{}'::jsonb),
  ('together:Qwen/Qwen3-0.6B', 'together', 'Qwen/Qwen3-0.6B', 'Qwen3 0.6B', '', 'qwen3', 40960, NULL, true, false, false, 'llm', NULL, 999, '{}'::jsonb),
  ('together:Qwen/Qwen3-1.7B', 'together', 'Qwen/Qwen3-1.7B', 'Qwen3 1.7B', '', 'qwen3', 40960, NULL, true, false, false, 'llm', NULL, 999, '{}'::jsonb),
  ('together:Qwen/Qwen3-14B', 'together', 'Qwen/Qwen3-14B', 'Qwen3 14B', '', 'qwen3', 2048, NULL, true, false, false, 'llm', NULL, 999, '{}'::jsonb),
  ('together:Qwen/Qwen3-235B-A22B-Instruct-2507-FP8', 'together', 'Qwen/Qwen3-235B-A22B-Instruct-2507-FP8', 'Qwen3 235B A22b Instruct 2507 Fp8', '', 'qwen3', 262144, NULL, true, false, false, 'llm', NULL, 999, '{}'::jsonb),
  ('together:Qwen/Qwen3-235B-A22B-Instruct-2507-tput', 'together', 'Qwen/Qwen3-235B-A22B-Instruct-2507-tput', 'Qwen3 235B A22B Instruct 2507 FP8 Throughput', '', 'qwen3', 262144, NULL, true, false, false, 'llm', NULL, 999, '{}'::jsonb),
  ('together:Qwen/Qwen3-30B-A3B', 'together', 'Qwen/Qwen3-30B-A3B', 'Qwen3 30B A3b', '', 'qwen3', 40960, NULL, true, false, false, 'llm', NULL, 999, '{}'::jsonb),
  ('together:Qwen/Qwen3-30B-A3B-Instruct-2507-Lora', 'together', 'Qwen/Qwen3-30B-A3B-Instruct-2507-Lora', 'Qwen3 30B A3B Instruct 2507 Lora', '', 'qwen3', 262144, NULL, true, false, false, 'llm', NULL, 999, '{}'::jsonb),
  ('together:Qwen/Qwen3-32B', 'together', 'Qwen/Qwen3-32B', 'Qwen3 32B', '', 'qwen3', 40960, NULL, true, false, false, 'llm', NULL, 999, '{}'::jsonb),
  ('together:Qwen/Qwen3-4B-Instruct-2507', 'together', 'Qwen/Qwen3-4B-Instruct-2507', 'Qwen3 4B Instruct 2507', '', 'qwen3', 262144, NULL, true, false, false, 'llm', NULL, 999, '{}'::jsonb),
  ('together:Qwen/Qwen3-8B', 'together', 'Qwen/Qwen3-8B', 'Qwen3 8B', '', 'qwen3', 40960, NULL, true, false, false, 'llm', NULL, 999, '{}'::jsonb),
  ('together:Qwen/Qwen3-8B-Lora', 'together', 'Qwen/Qwen3-8B-Lora', 'Qwen3 8B Lora', '', 'qwen3', 40960, NULL, true, false, false, 'llm', NULL, 999, '{}'::jsonb),
  ('together:Qwen/Qwen3-Coder-30B-A3B-Instruct', 'together', 'Qwen/Qwen3-Coder-30B-A3B-Instruct', 'Qwen3 Coder 30B A3b Instruct', '', 'qwen3', 262144, NULL, true, false, false, 'llm', NULL, 999, '{}'::jsonb),
  ('together:Qwen/Qwen3-Coder-480B-A35B-Instruct-FP8', 'together', 'Qwen/Qwen3-Coder-480B-A35B-Instruct-FP8', 'Qwen3 Coder 480B A35B Instruct Fp8', '', 'qwen3', 262144, NULL, true, false, false, 'llm', NULL, 999, '{}'::jsonb),
  ('together:Qwen/Qwen3-Coder-Next-FP8', 'together', 'Qwen/Qwen3-Coder-Next-FP8', 'Qwen3 Coder Next Fp8', '', 'qwen3', 262144, NULL, true, false, false, 'llm', NULL, 999, '{}'::jsonb),
  ('together:Qwen/Qwen3-Next-80B-A3B-Instruct', 'together', 'Qwen/Qwen3-Next-80B-A3B-Instruct', 'Qwen3 Next 80B A3b Instruct', '', 'qwen3', 262144, NULL, true, false, false, 'llm', NULL, 999, '{}'::jsonb),
  ('together:Qwen/Qwen3-Next-80B-A3B-Instruct-FP8', 'together', 'Qwen/Qwen3-Next-80B-A3B-Instruct-FP8', 'Qwen3 Next 80B A3b Instruct Fp8', '', 'qwen3', 0, NULL, true, false, false, 'llm', NULL, 999, '{}'::jsonb),
  ('together:Qwen/Qwen3-Next-80B-A3B-Thinking', 'together', 'Qwen/Qwen3-Next-80B-A3B-Thinking', 'Qwen3 Next 80B A3b Thinking', '', 'qwen3', 262144, NULL, true, false, false, 'llm', NULL, 999, '{}'::jsonb),
  ('together:Qwen/Qwen3-VL-235B-A22B-Instruct-FP8', 'together', 'Qwen/Qwen3-VL-235B-A22B-Instruct-FP8', 'Qwen3-VL-235B-A22B-Instruct-FP8', '', 'qwen3', 262144, NULL, true, false, false, 'llm', NULL, 999, '{}'::jsonb),
  ('together:Qwen/Qwen3-VL-32B-Instruct', 'together', 'Qwen/Qwen3-VL-32B-Instruct', 'Qwen3-VL-32B-Instruct', '', 'qwen3', 262144, NULL, true, false, false, 'llm', NULL, 999, '{}'::jsonb),
  ('together:Qwen/Qwen3-VL-8B-Instruct', 'together', 'Qwen/Qwen3-VL-8B-Instruct', 'Qwen3-VL-8B-Instruct', '', 'qwen3', 262144, NULL, true, false, false, 'llm', NULL, 999, '{}'::jsonb),
  ('together:Qwen/Qwen3.5-122B-A10B-FP8', 'together', 'Qwen/Qwen3.5-122B-A10B-FP8', 'Qwen3.5 122B A10b Fp8', '', 'qwen3', 262144, NULL, true, false, false, 'llm', NULL, 999, '{}'::jsonb),
  ('together:Qwen/Qwen3.5-2B-Lora', 'together', 'Qwen/Qwen3.5-2B-Lora', 'Qwen3.5 2B Lora', '', 'qwen3', 262144, NULL, true, false, false, 'llm', NULL, 999, '{}'::jsonb),
  ('together:Qwen/Qwen3.5-35B-A3B', 'together', 'Qwen/Qwen3.5-35B-A3B', 'Qwen3.5 35B A3b', '', 'qwen3', 262144, NULL, true, false, false, 'llm', NULL, 999, '{}'::jsonb),
  ('together:Qwen/Qwen3.5-35B-A3B-Lora', 'together', 'Qwen/Qwen3.5-35B-A3B-Lora', 'Qwen3.5 35B A3B Lora', '', 'qwen3', 262144, NULL, true, false, false, 'llm', NULL, 999, '{}'::jsonb),
  ('together:Qwen/Qwen3.5-397B-A17B', 'together', 'Qwen/Qwen3.5-397B-A17B', 'Qwen3.5 397B A17b', '', 'qwen3', 262144, NULL, true, false, false, 'llm', NULL, 999, '{}'::jsonb),
  ('together:Qwen/Qwen3.5-9B', 'together', 'Qwen/Qwen3.5-9B', 'Qwen3.5 9B FP8', '', 'qwen3', 262144, NULL, true, false, false, 'llm', NULL, 999, '{}'::jsonb),
  ('together:Qwen/Qwen3.5-9B-FP8', 'together', 'Qwen/Qwen3.5-9B-FP8', 'Qwen3.5 9B Fp8', '', 'qwen3', 262144, NULL, true, false, false, 'llm', NULL, 999, '{}'::jsonb),
  ('together:Qwen/Qwen3.6-35B-A3B-FP8', 'together', 'Qwen/Qwen3.6-35B-A3B-FP8', 'Qwen3.6 35B A3b Fp8', '', 'qwen3', 262144, NULL, true, false, false, 'llm', NULL, 999, '{}'::jsonb),
  ('together:Qwen/Qwen3.6-35B-A3B-Lora', 'together', 'Qwen/Qwen3.6-35B-A3B-Lora', 'Qwen3.6 35B A3B Lora', '', 'qwen3', 262144, NULL, true, false, false, 'llm', NULL, 999, '{}'::jsonb),
  ('together:Qwen/Qwen3.6-Plus', 'together', 'Qwen/Qwen3.6-Plus', 'Qwen3.6 Plus', '', 'qwen3', 1000000, NULL, true, false, false, 'llm', NULL, 999, '{}'::jsonb),
  ('together:Qwen/Qwen3.7-Max', 'together', 'Qwen/Qwen3.7-Max', 'Qwen3.7 Max', '', 'qwen3', 1000000, NULL, true, false, false, 'llm', NULL, 999, '{}'::jsonb),
  ('together:Qwen/Qwen3.7-Plus', 'together', 'Qwen/Qwen3.7-Plus', 'Qwen3.7 Plus', '', 'qwen3', 1000000, NULL, true, false, false, 'llm', NULL, 999, '{}'::jsonb),
  ('together:Qwen/Qwen3.8-Flash', 'together', 'Qwen/Qwen3.8-Flash', 'Qwen3.8 Flash', '', 'qwen3', 1000000, NULL, true, false, false, 'llm', NULL, 999, '{}'::jsonb),
  ('together:agentica-org/DeepCoder-14B-Preview', 'together', 'agentica-org/DeepCoder-14B-Preview', 'Deepcoder 14B Preview', '', 'togethercomputer', 131072, NULL, false, false, false, 'llm', NULL, 999, '{}'::jsonb),
  ('together:allenai/Molmo-7B-D-0924', 'together', 'allenai/Molmo-7B-D-0924', 'Molmo 7B D 0924', '', 'allenai', 4096, NULL, false, false, false, 'llm', NULL, 999, '{}'::jsonb),
  ('together:arcee-ai/trinity-mini', 'together', 'arcee-ai/trinity-mini', 'Trinity Mini', '', 'arcee ai', 128000, NULL, false, false, false, 'llm', NULL, 999, '{}'::jsonb),
  ('together:arize-ai/qwen-2-1.5b-instruct', 'together', 'arize-ai/qwen-2-1.5b-instruct', 'Arize AI Qwen 2 1.5B Instruct', '', 'togethercomputer', 32768, NULL, false, false, false, 'llm', NULL, 999, '{}'::jsonb),
  ('together:deepcogito/cogito-v1-preview-llama-70B', 'together', 'deepcogito/cogito-v1-preview-llama-70B', 'Cogito V1 Preview Llama 70B', '', 'deepcogito', 131072, NULL, false, false, false, 'llm', NULL, 999, '{}'::jsonb),
  ('together:deepcogito/cogito-v1-preview-llama-70B-Turbo', 'together', 'deepcogito/cogito-v1-preview-llama-70B-Turbo', 'Cogito V1 Preview Llama 70B Turbo', '', 'deepcogito', 131072, NULL, false, false, false, 'llm', NULL, 999, '{}'::jsonb),
  ('together:deepcogito/cogito-v1-preview-llama-8B', 'together', 'deepcogito/cogito-v1-preview-llama-8B', 'Cogito V1 Preview Llama 8B', '', 'deepcogito', 131072, NULL, false, false, false, 'llm', NULL, 999, '{}'::jsonb),
  ('together:deepcogito/cogito-v1-preview-qwen-14B', 'together', 'deepcogito/cogito-v1-preview-qwen-14B', 'Cogito V1 Preview Qwen 14B', '', 'deepcogito', 131072, NULL, false, false, false, 'llm', NULL, 999, '{}'::jsonb),
  ('together:deepcogito/cogito-v1-preview-qwen-32B', 'together', 'deepcogito/cogito-v1-preview-qwen-32B', 'Cogito V1 Preview Qwen 32B', '', 'deepcogito', 131072, NULL, false, false, false, 'llm', NULL, 999, '{}'::jsonb),
  ('together:deepcogito/cogito-v2-1-671b', 'together', 'deepcogito/cogito-v2-1-671b', 'Cogito v2.1 671B', '', 'deepcogito', 163840, NULL, false, false, false, 'llm', NULL, 999, '{}'::jsonb),
  ('together:deepseek-ai/DeepSeek-OCR-2', 'together', 'deepseek-ai/DeepSeek-OCR-2', 'Deepseek OCR 2', '', 'deepseek', 8192, NULL, false, false, false, 'llm', NULL, 999, '{}'::jsonb),
  ('together:deepseek-ai/DeepSeek-R1-0528', 'together', 'deepseek-ai/DeepSeek-R1-0528', 'DeepSeek R1 0528 NVFP4', '', 'deepseek-r1', 163840, NULL, true, false, true, 'llm', NULL, 999, '{}'::jsonb),
  ('together:deepseek-ai/DeepSeek-R1-Distill-Llama-70B', 'together', 'deepseek-ai/DeepSeek-R1-Distill-Llama-70B', 'DeepSeek R1 Distill Llama 70B', '', 'deepseek-r1', 131072, NULL, true, false, true, 'llm', NULL, 999, '{}'::jsonb),
  ('together:deepseek-ai/DeepSeek-R1-Distill-Qwen-1.5B', 'together', 'deepseek-ai/DeepSeek-R1-Distill-Qwen-1.5B', 'DeepSeek R1 Distill Qwen 1.5B', '', 'deepseek-r1', 131072, NULL, true, false, true, 'llm', NULL, 999, '{}'::jsonb),
  ('together:deepseek-ai/DeepSeek-R1-Distill-Qwen-14B', 'together', 'deepseek-ai/DeepSeek-R1-Distill-Qwen-14B', 'DeepSeek R1 Distill Qwen 14B', '', 'deepseek-r1', 131072, NULL, true, false, true, 'llm', NULL, 999, '{}'::jsonb),
  ('together:deepseek-ai/DeepSeek-R1-Distill-Qwen-7B', 'together', 'deepseek-ai/DeepSeek-R1-Distill-Qwen-7B', 'DeepSeek R1 Distill Qwen 7B', '', 'deepseek-r1', 131072, NULL, true, false, true, 'llm', NULL, 999, '{}'::jsonb),
  ('together:deepseek-ai/DeepSeek-V3.1', 'together', 'deepseek-ai/DeepSeek-V3.1', 'Deepseek V3.1 NVFP4', '', 'deepseek-v3', 131072, NULL, true, false, false, 'llm', NULL, 999, '{}'::jsonb),
  ('together:deepseek-ai/DeepSeek-V4-Pro', 'together', 'deepseek-ai/DeepSeek-V4-Pro', 'Deepseek V4 Pro', '', 'deepseek', 512000, NULL, false, false, false, 'llm', NULL, 999, '{}'::jsonb),
  ('together:deepseek-ai/DeepSeek-V4.1-Flash-1017', 'together', 'deepseek-ai/DeepSeek-V4.1-Flash-1017', 'DeepSeek V4.1 Flash 1017', '', 'deepseek', 1000000, NULL, false, false, false, 'llm', NULL, 999, '{}'::jsonb),
  ('together:deepseek-ai/deepseek-coder-33b-instruct', 'together', 'deepseek-ai/deepseek-coder-33b-instruct', 'Deepseek Coder 33B Instruct', '', 'deepseek', 16384, NULL, false, false, false, 'llm', NULL, 999, '{}'::jsonb),
  ('together:google/gemma-2-27b-it', 'together', 'google/gemma-2-27b-it', 'Gemma-2 Instruct (27B)', '', 'gemma-2', 8192, NULL, false, false, false, 'llm', NULL, 999, '{}'::jsonb),
  ('together:google/gemma-2-9b-it', 'together', 'google/gemma-2-9b-it', 'Gemma 2 9B It', '', 'gemma-2', 8192, NULL, false, false, false, 'llm', NULL, 999, '{}'::jsonb),
  ('together:google/gemma-2b-it', 'together', 'google/gemma-2b-it', 'Gemma 2B It', '', 'gemma-2', 8192, NULL, false, false, false, 'llm', NULL, 999, '{}'::jsonb),
  ('together:google/gemma-3-1b-it', 'together', 'google/gemma-3-1b-it', 'Gemma 3 1b it', '', 'gemma-3', 32768, NULL, false, false, false, 'llm', NULL, 999, '{}'::jsonb),
  ('together:google/gemma-3-270m-it', 'together', 'google/gemma-3-270m-it', 'Gemma 3 270M It', '', 'gemma-3', 32768, NULL, false, false, false, 'llm', NULL, 999, '{}'::jsonb),
  ('together:google/gemma-3-270m-it-lora', 'together', 'google/gemma-3-270m-it-lora', 'Gemma 3 270M It Lora', '', 'gemma-3', 32768, NULL, false, false, false, 'llm', NULL, 999, '{}'::jsonb),
  ('together:google/gemma-3-27b-it', 'together', 'google/gemma-3-27b-it', 'Gemma 3 27B It', '', 'gemma-3', 65536, NULL, false, false, false, 'llm', NULL, 999, '{}'::jsonb),
  ('together:google/gemma-3-4b-it', 'together', 'google/gemma-3-4b-it', 'Gemma 3 4b it', '', 'gemma-3', 65536, NULL, false, false, false, 'llm', NULL, 999, '{}'::jsonb),
  ('together:google/gemma-3n-E4B-it', 'together', 'google/gemma-3n-E4B-it', 'Gemma 3N E4B Instruct', '', 'gemma-3', 32768, NULL, false, false, false, 'llm', NULL, 999, '{}'::jsonb),
  ('together:google/gemma-4-12B-it', 'together', 'google/gemma-4-12B-it', 'Gemma 4 12B It', '', 'gemma', 262144, NULL, false, false, false, 'llm', NULL, 999, '{}'::jsonb),
  ('together:google/gemma-4-26B-A4B-it', 'together', 'google/gemma-4-26B-A4B-it', 'Gemma 4 26B A4b It', '', 'gemma', 262144, NULL, false, false, false, 'llm', NULL, 999, '{}'::jsonb),
  ('together:google/gemma-4-31B-it', 'together', 'google/gemma-4-31B-it', 'Gemma 4 31B-it FP8', '', 'gemma', 262144, NULL, false, false, false, 'llm', NULL, 999, '{}'::jsonb),
  ('together:google/gemma-4-31B-it-lora', 'together', 'google/gemma-4-31B-it-lora', 'Gemma 4 31B It Lora', '', 'gemma', 262144, NULL, false, false, false, 'llm', NULL, 999, '{}'::jsonb),
  ('together:google/gemma-4-E2B-it', 'together', 'google/gemma-4-E2B-it', 'Gemma 4 E2B-it', '', 'gemma', 131072, NULL, false, false, false, 'llm', NULL, 999, '{}'::jsonb),
  ('together:google/gemma-4-E4B-it', 'together', 'google/gemma-4-E4B-it', 'Gemma 4 E4B-it', '', 'gemma', 131072, NULL, false, false, false, 'llm', NULL, 999, '{}'::jsonb),
  ('together:google/medgemma-27b-text-it', 'together', 'google/medgemma-27b-text-it', 'Medgemma 27B Text It', '', 'gemma-2', 131072, NULL, false, false, false, 'llm', NULL, 999, '{}'::jsonb),
  ('together:meta-llama/Llama-2-7b-chat-hf', 'together', 'meta-llama/Llama-2-7b-chat-hf', 'meta-llama/Llama-2-7b-chat-hf', '', 'llama-2', 4096, NULL, false, false, false, 'llm', NULL, 999, '{}'::jsonb),
  ('together:meta-llama/Llama-3-8b-chat-hf', 'together', 'meta-llama/Llama-3-8b-chat-hf', 'Meta Llama 3 8B Instruct Reference', '', 'llama-3', 8192, NULL, false, false, false, 'llm', NULL, 999, '{}'::jsonb),
  ('together:meta-llama/Llama-3.1-405B', 'together', 'meta-llama/Llama-3.1-405B', 'Llama 3.1 405B', '', 'llama-3.1', 131072, NULL, true, false, false, 'llm', NULL, 999, '{}'::jsonb),
  ('together:meta-llama/Llama-3.1-405B-Instruct', 'together', 'meta-llama/Llama-3.1-405B-Instruct', 'Meta Llama 3.1 405B Instruct', '', 'llama-3.1', 4096, NULL, true, false, false, 'llm', NULL, 999, '{}'::jsonb),
  ('together:meta-llama/Llama-3.2-1B', 'together', 'meta-llama/Llama-3.2-1B', 'Llama 3.2 1B', '', 'llama-3.2', 131072, NULL, true, false, false, 'llm', NULL, 999, '{}'::jsonb),
  ('together:meta-llama/Llama-3.2-1B-Instruct', 'together', 'meta-llama/Llama-3.2-1B-Instruct', 'Meta Llama 3.2 1B Instruct', '', 'llama-3.2', 131072, NULL, true, false, false, 'llm', NULL, 999, '{}'::jsonb),
  ('together:meta-llama/Llama-3.2-3B-Instruct', 'together', 'meta-llama/Llama-3.2-3B-Instruct', 'Meta Llama 3.2 3B Instruct', '', 'llama-3.2', 131072, NULL, true, false, false, 'llm', NULL, 999, '{}'::jsonb),
  ('together:meta-llama/Llama-3.3-70B-Instruct', 'together', 'meta-llama/Llama-3.3-70B-Instruct', 'Meta Llama 3.3 70B Instruct', '', 'llama-3.3', 131072, NULL, true, false, false, 'llm', NULL, 999, '{}'::jsonb),
  ('together:meta-llama/Llama-3.3-70B-Instruct-FP8-Lora', 'together', 'meta-llama/Llama-3.3-70B-Instruct-FP8-Lora', 'Llama 3.3 70B Instruct FP8 Lora', '', 'llama-3.3', 131072, NULL, true, false, false, 'llm', NULL, 999, '{}'::jsonb),
  ('together:meta-llama/Llama-3.3-70B-Instruct-Turbo', 'together', 'meta-llama/Llama-3.3-70B-Instruct-Turbo', 'Meta Llama 3.3 70B Instruct Turbo', '', 'llama-3.3', 131072, NULL, true, false, false, 'llm', NULL, 999, '{}'::jsonb),
  ('together:meta-llama/Llama-4-Maverick-17B-128E-Instruct-FP4', 'together', 'meta-llama/Llama-4-Maverick-17B-128E-Instruct-FP4', 'Llama 4 Maverick 17B 128E Instruct Nvfp4', '', 'llama-4', 1048576, NULL, true, true, false, 'llm', NULL, 999, '{}'::jsonb),
  ('together:meta-llama/Llama-4-Scout-17B-16E', 'together', 'meta-llama/Llama-4-Scout-17B-16E', 'Llama 4 Scout (17Bx16E)', '', 'llama-4', 262144, NULL, true, true, false, 'llm', NULL, 999, '{}'::jsonb),
  ('together:meta-llama/Llama-4-Scout-17B-16E-Instruct', 'together', 'meta-llama/Llama-4-Scout-17B-16E-Instruct', 'Llama 4 Scout Instruct (17Bx16E)', '', 'llama-4', 1048576, NULL, true, true, false, 'llm', NULL, 999, '{}'::jsonb),
  ('together:meta-llama/Llama-4-Scout-17B-16E-Instruct-FP8-Lora', 'together', 'meta-llama/Llama-4-Scout-17B-16E-Instruct-FP8-Lora', 'Llama 4 Scout 17B 16E Instruct Fp8 Lora', '', 'llama-4', 10485760, NULL, true, true, false, 'llm', NULL, 999, '{}'::jsonb),
  ('together:meta-llama/Meta-Llama-3-70B-Instruct-Turbo', 'together', 'meta-llama/Meta-Llama-3-70B-Instruct-Turbo', 'Meta Llama 3 70B Instruct Turbo', '', 'llama-3', 8192, NULL, false, false, false, 'llm', NULL, 999, '{}'::jsonb),
  ('together:meta-llama/Meta-Llama-3-8B-Instruct', 'together', 'meta-llama/Meta-Llama-3-8B-Instruct', 'Meta Llama 3 8B Instruct', '', 'llama-3', 8192, NULL, false, false, false, 'llm', NULL, 999, '{}'::jsonb),
  ('together:meta-llama/Meta-Llama-3-8B-Instruct-Lite', 'together', 'meta-llama/Meta-Llama-3-8B-Instruct-Lite', 'Meta Llama 3 8B Instruct Lite', '', 'llama-3', 8192, NULL, false, false, false, 'llm', NULL, 999, '{}'::jsonb),
  ('together:meta-llama/Meta-Llama-3.1-70B', 'together', 'meta-llama/Meta-Llama-3.1-70B', 'Llama 3.1 70B', '', 'llama-3.1', 131072, NULL, true, false, false, 'llm', NULL, 999, '{}'::jsonb),
  ('together:meta-llama/Meta-Llama-3.1-70B-Instruct-Turbo', 'together', 'meta-llama/Meta-Llama-3.1-70B-Instruct-Turbo', 'Meta Llama 3.1 70B Instruct Turbo', '', 'llama-3.1', 131072, NULL, true, false, false, 'llm', NULL, 999, '{}'::jsonb),
  ('together:meta-llama/Meta-Llama-3.1-8B-Instruct-Turbo', 'together', 'meta-llama/Meta-Llama-3.1-8B-Instruct-Turbo', 'Meta Llama 3.1 8B Instruct Turbo', '', 'llama-3.1', 131072, NULL, true, false, false, 'llm', NULL, 999, '{}'::jsonb),
  ('together:mistralai/Devstral-Small-2505', 'together', 'mistralai/Devstral-Small-2505', 'Devstral Small 2505', '', 'mistral', 131072, NULL, false, false, false, 'llm', NULL, 999, '{}'::jsonb),
  ('together:mistralai/Magistral-Small-2506', 'together', 'mistralai/Magistral-Small-2506', 'Magistral Small 2506', '', 'mistral', 40960, NULL, false, false, false, 'llm', NULL, 999, '{}'::jsonb),
  ('together:mistralai/Ministral-3-14B-Instruct-2512', 'together', 'mistralai/Ministral-3-14B-Instruct-2512', 'Ministral 3 14B Instruct 2512', '', 'mistral', 262144, NULL, false, false, false, 'llm', NULL, 999, '{}'::jsonb),
  ('together:mistralai/Mistral-7B-Instruct-v0.1', 'together', 'mistralai/Mistral-7B-Instruct-v0.1', 'Mistral (7B) Instruct v0.1', '', 'mistral', 32768, NULL, false, false, false, 'llm', NULL, 999, '{}'::jsonb),
  ('together:mistralai/Mistral-7B-Instruct-v0.3', 'together', 'mistralai/Mistral-7B-Instruct-v0.3', 'Mistral (7B) Instruct v0.3', '', 'mistral', 32768, NULL, true, false, false, 'llm', NULL, 999, '{}'::jsonb),
  ('together:mistralai/Mistral-7B-v0.1', 'together', 'mistralai/Mistral-7B-v0.1', 'Mistral 7B v0.1', '', 'mistral', 32768, NULL, false, false, false, 'llm', NULL, 999, '{}'::jsonb),
  ('together:mistralai/Mistral-Small-24B-Instruct-2501', 'together', 'mistralai/Mistral-Small-24B-Instruct-2501', 'Mistral Small (24B) Instruct 25.01', '', 'mistral', 32768, NULL, true, false, false, 'llm', NULL, 999, '{}'::jsonb),
  ('together:mistralai/Mixtral-8x22B-Instruct-v0.1', 'together', 'mistralai/Mixtral-8x22B-Instruct-v0.1', 'Mixtral 8X22b Instruct V0.1', '', 'mixtral', 65536, NULL, true, false, false, 'llm', NULL, 999, '{}'::jsonb),
  ('together:mistralai/Mixtral-8x7B-Instruct-v0.1', 'together', 'mistralai/Mixtral-8x7B-Instruct-v0.1', 'Mixtral-8x7B Instruct v0.1', '', 'mixtral', 32768, NULL, true, false, false, 'llm', NULL, 999, '{}'::jsonb),
  ('together:mistralai/Mixtral-8x7B-Instruct-v0.1-FP8-Lora', 'together', 'mistralai/Mixtral-8x7B-Instruct-v0.1-FP8-Lora', 'Mixtral 8x7B Instruct V0.1 FP8 Lora', '', 'mixtral', 32768, NULL, true, false, false, 'llm', NULL, 999, '{}'::jsonb),
  ('together:moonshotai/Kimi-K2.5-fp4', 'together', 'moonshotai/Kimi-K2.5-fp4', 'Kimi K2.5 Fp4', '', 'togethercomputer', 262144, NULL, false, false, false, 'llm', NULL, 999, '{}'::jsonb),
  ('together:moonshotai/Kimi-K2.6', 'together', 'moonshotai/Kimi-K2.6', 'Kimi K2.6 Fp4', '', 'moonshot ai', 262144, NULL, false, false, false, 'llm', NULL, 999, '{}'::jsonb),
  ('together:moonshotai/Kimi-K2.7-Code', 'together', 'moonshotai/Kimi-K2.7-Code', 'Kimi K2.7 Code', '', 'moonshot ai', 262144, NULL, false, false, false, 'llm', NULL, 999, '{}'::jsonb),
  ('together:moonshotai/Kimi-K3.1-Pro', 'together', 'moonshotai/Kimi-K3.1-Pro', 'Kimi K3.1 Pro', '', 'moonshot ai', 1048576, NULL, false, false, false, 'llm', NULL, 999, '{}'::jsonb),
  ('together:nim/meta/llama-3.1-70b-instruct', 'together', 'nim/meta/llama-3.1-70b-instruct', 'nim/meta/llama-3.1-70b-instruct', '', 'llama-3.1', 16384, NULL, true, false, false, 'llm', NULL, 999, '{}'::jsonb),
  ('together:nim/meta/llama-3.1-8b-instruct', 'together', 'nim/meta/llama-3.1-8b-instruct', 'nim/meta/llama-3.1-8b-instruct', '', 'llama-3.1', 16384, NULL, true, false, false, 'llm', NULL, 999, '{}'::jsonb),
  ('together:nim/meta/llama-3.2-11b-vision-instruct', 'together', 'nim/meta/llama-3.2-11b-vision-instruct', 'nim/meta/llama-3.2-11b-vision-instruct', '', 'llama-3.2', 16384, NULL, true, true, false, 'llm', NULL, 999, '{}'::jsonb),
  ('together:nim/meta/llama-3.2-90b-vision-instruct', 'together', 'nim/meta/llama-3.2-90b-vision-instruct', 'nim/meta/llama-3.2-90b-vision-instruct', '', 'llama-3.2', 16384, NULL, true, true, false, 'llm', NULL, 999, '{}'::jsonb),
  ('together:nim/meta/llama-3.3-70b-instruct', 'together', 'nim/meta/llama-3.3-70b-instruct', 'nim/meta/llama-3.3-70b-instruct', '', 'llama-3.3', 16384, NULL, true, false, false, 'llm', NULL, 999, '{}'::jsonb),
  ('together:nim/mistralai/mixtral-8x22b-instruct-v01', 'together', 'nim/mistralai/mixtral-8x22b-instruct-v01', 'nim/mistralai/mixtral-8x22b-instruct-v01', '', 'mixtral', 16384, NULL, true, false, false, 'llm', NULL, 999, '{}'::jsonb),
  ('together:nim/mistralai/mixtral-8x7b-instruct-v01', 'together', 'nim/mistralai/mixtral-8x7b-instruct-v01', 'nim/mistralai/mixtral-8x7b-instruct-v01', '', 'mixtral', 16384, NULL, true, false, false, 'llm', NULL, 999, '{}'::jsonb),
  ('together:nim/nv-mistralai/mistral-nemo-12b-instruct', 'together', 'nim/nv-mistralai/mistral-nemo-12b-instruct', 'nim/nv-mistralai/mistral-nemo-12b-instruct', '', 'mistral', 16384, NULL, false, false, false, 'llm', NULL, 999, '{}'::jsonb),
  ('together:nim/nvidia/llama-3.1-nemotron-70b-instruct', 'together', 'nim/nvidia/llama-3.1-nemotron-70b-instruct', 'nim/nvidia/llama-3.1-nemotron-70b-instruct', '', 'llama-3.1', 16384, NULL, true, false, false, 'llm', NULL, 999, '{}'::jsonb),
  ('together:nim/nvidia/llama-3.3-nemotron-super-49b-v1', 'together', 'nim/nvidia/llama-3.3-nemotron-super-49b-v1', 'nim/nvidia/llama-3.3-nemotron-super-49b-v1', '', 'llama-3.3', 16384, NULL, true, false, false, 'llm', NULL, 999, '{}'::jsonb),
  ('together:nvidia/Llama-3.1-Nemotron-70B-Instruct-HF', 'together', 'nvidia/Llama-3.1-Nemotron-70B-Instruct-HF', 'Llama 3.1 Nemotron 70B Instruct HF', '', 'llama-3.1', 32768, NULL, true, false, false, 'llm', NULL, 999, '{}'::jsonb),
  ('together:nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B-BF16', 'together', 'nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B-BF16', 'Nvidia Nemotron 3 Nano 30B A3b Bf16', '', 'nvidia', 262144, NULL, false, false, false, 'llm', NULL, 999, '{}'::jsonb),
  ('together:nvidia/NVIDIA-Nemotron-3-Super-120B-A12B-BF16', 'together', 'nvidia/NVIDIA-Nemotron-3-Super-120B-A12B-BF16', 'Nvidia Nemotron 3 Super 120B A12b Bf16', '', 'nvidia', 262144, NULL, false, false, false, 'llm', NULL, 999, '{}'::jsonb),
  ('together:nvidia/NVIDIA-Nemotron-3-Super-120B-A12B-FP8', 'together', 'nvidia/NVIDIA-Nemotron-3-Super-120B-A12B-FP8', 'Nvidia Nemotron 3 Super 120B A12b Fp8', '', 'nvidia', 262144, NULL, false, false, false, 'llm', NULL, 999, '{}'::jsonb),
  ('together:nvidia/NVIDIA-Nemotron-3.5-Super-VL', 'together', 'nvidia/NVIDIA-Nemotron-3.5-Super-VL', 'Nvidia Nemotron 3.5 Super VL', '', 'nvidia', 262144, NULL, false, false, false, 'llm', NULL, 999, '{}'::jsonb),
  ('together:nvidia/NVIDIA-Nemotron-Nano-9B-v2', 'together', 'nvidia/NVIDIA-Nemotron-Nano-9B-v2', 'Nvidia Nemotron Nano 9B V2', '', 'nvidia', 131072, NULL, false, false, false, 'llm', NULL, 999, '{}'::jsonb),
  ('together:nvidia/nemotron-3-nano-omni-30b-a3b-reasoning-fp8', 'together', 'nvidia/nemotron-3-nano-omni-30b-a3b-reasoning-fp8', 'Nemotron 3 Nano Omni 30B A3b Reasoning Fp8', '', 'nvidia', 131072, NULL, false, false, false, 'llm', NULL, 999, '{}'::jsonb),
  ('together:nvidia/nemotron-3-ultra-550b-a55b', 'together', 'nvidia/nemotron-3-ultra-550b-a55b', 'NVIDIA Nemotron 3 Ultra 550B A55B NVFP4', '', 'nvidia', 512288, NULL, false, false, false, 'llm', NULL, 999, '{}'::jsonb),
  ('together:openai/gpt-oss-120b', 'together', 'openai/gpt-oss-120b', 'OpenAI GPT-OSS 120B', '', 'gpt-oss', 131072, NULL, true, false, true, 'llm', NULL, 999, '{}'::jsonb),
  ('together:openai/gpt-oss-20b', 'together', 'openai/gpt-oss-20b', 'OpenAI GPT-OSS 20B', '', 'gpt-oss', 131072, NULL, true, false, true, 'llm', NULL, 999, '{}'::jsonb),
  ('together:pearl-ai/gemma-4-31b-it', 'together', 'pearl-ai/gemma-4-31b-it', 'Pearl-ai Gemma-4-31B-it-pearl', '', 'gemma', 262144, NULL, false, false, false, 'llm', NULL, 999, '{}'::jsonb),
  ('together:sarvamai/sarvam-m', 'together', 'sarvamai/sarvam-m', 'Sarvam M', '', 'sarvamai', 32768, NULL, false, false, false, 'llm', NULL, 999, '{}'::jsonb),
  ('together:thinkingmachines/Inkling', 'together', 'thinkingmachines/Inkling', 'Inkling FP4', '', 'thinking machines', 524288, NULL, false, false, false, 'llm', NULL, 999, '{}'::jsonb),
  ('together:togethercomputer/EssentialAI-RNJ-1-Instruct', 'together', 'togethercomputer/EssentialAI-RNJ-1-Instruct', 'EssentialAI Rnj-1 Instruct', '', 'essential ai', 32768, NULL, false, false, false, 'llm', NULL, 999, '{}'::jsonb),
  ('together:togethercomputer/meta-llama-3.1-8B-Instruct-AWQ-INT4', 'together', 'togethercomputer/meta-llama-3.1-8B-Instruct-AWQ-INT4', 'Meta Llama 3.1 8B Instruct Awq Int4', '', 'llama-3.1', 131072, NULL, true, false, false, 'llm', NULL, 999, '{}'::jsonb),
  ('together:zai-org/GLM-4.5-Air-FP8', 'together', 'zai-org/GLM-4.5-Air-FP8', 'Glm 4.5 Air Fp8', '', 'zai org', 131072, NULL, false, false, false, 'llm', NULL, 999, '{}'::jsonb),
  ('together:zai-org/GLM-4.5V', 'together', 'zai-org/GLM-4.5V', 'GLM 4.5V', '', 'zai org', 65536, NULL, false, false, false, 'llm', NULL, 999, '{}'::jsonb),
  ('together:zai-org/GLM-4.6', 'together', 'zai-org/GLM-4.6', 'GLM 4.6 Fp8', '', 'zai org', 202752, NULL, false, false, false, 'llm', NULL, 999, '{}'::jsonb),
  ('together:zai-org/GLM-4.7', 'together', 'zai-org/GLM-4.7', 'GLM 4.7 FP8', '', 'zai org', 202752, NULL, false, false, false, 'llm', NULL, 999, '{}'::jsonb),
  ('together:zai-org/GLM-4.7-FP8', 'together', 'zai-org/GLM-4.7-FP8', 'Glm 4.7 Fp8', '', 'zai org', 202752, NULL, false, false, false, 'llm', NULL, 999, '{}'::jsonb),
  ('together:zai-org/GLM-4.7-fp4', 'together', 'zai-org/GLM-4.7-fp4', 'GLM 4.7 FP4', '', 'zai org', 202752, NULL, false, false, false, 'llm', NULL, 999, '{}'::jsonb),
  ('together:zai-org/GLM-5', 'together', 'zai-org/GLM-5', 'GLM 5 Fp4', '', 'zai org', 202752, NULL, false, false, false, 'llm', NULL, 999, '{}'::jsonb),
  ('together:zai-org/GLM-5-FP4', 'together', 'zai-org/GLM-5-FP4', 'GLM 5 Fp4', '', 'zai org', 202752, NULL, false, false, false, 'llm', NULL, 999, '{}'::jsonb),
  ('together:zai-org/GLM-5.1', 'together', 'zai-org/GLM-5.1', 'GLM 5.1 FP4', '', 'zai org', 202752, NULL, false, false, false, 'llm', NULL, 999, '{}'::jsonb),
  ('together:zai-org/GLM-5.2', 'together', 'zai-org/GLM-5.2', 'GLM 5.2', '', 'zai org', 262144, NULL, false, false, false, 'llm', NULL, 999, '{}'::jsonb),
  ('together:zai-org/GLM-5.3', 'together', 'zai-org/GLM-5.3', 'GLM 5.3', '', 'zai org', 1048575, NULL, false, false, false, 'llm', NULL, 999, '{}'::jsonb),
  ('together:zai-org/GLM-5.3-Flash', 'together', 'zai-org/GLM-5.3-Flash', 'GLM 5.3 Flash', '', 'zai org', 1048575, NULL, true, false, false, 'llm', NULL, 999, '{}'::jsonb),
  ('together:zai-org/GLM-OCR', 'together', 'zai-org/GLM-OCR', 'GLM OCR', '', 'zai org', 131072, NULL, false, false, false, 'llm', NULL, 999, '{}'::jsonb)
ON CONFLICT DO NOTHING;

-- xAI — Grok. (8 models)
INSERT INTO public.models (
  id, provider_id, model_id, display_name, description, family,
  context_window_tokens, max_output_tokens, supports_tools, supports_vision,
  supports_reasoning, type, dimensions, sort_order, metadata
) VALUES
  ('xai:grok-4.20-0309-non-reasoning', 'xai', 'grok-4.20-0309-non-reasoning', 'Grok 4.20 0309 Non Reasoning', '', 'grok-4', 1000000, NULL, true, true, false, 'llm', NULL, 999, '{}'::jsonb),
  ('xai:grok-4.20-0309-reasoning', 'xai', 'grok-4.20-0309-reasoning', 'Grok 4.20 0309 Reasoning', '', 'grok-4', 1000000, NULL, true, true, true, 'llm', NULL, 999, '{}'::jsonb),
  ('xai:grok-4.20-multi-agent-0309', 'xai', 'grok-4.20-multi-agent-0309', 'Grok 4.20 Multi Agent 0309', '', 'grok-4', 1000000, NULL, true, true, true, 'llm', NULL, 999, '{}'::jsonb),
  ('xai:grok-4.3', 'xai', 'grok-4.3', 'Grok 4.3', '', 'grok-4', 1000000, NULL, true, true, true, 'llm', NULL, 999, '{}'::jsonb),
  ('xai:grok-4.5', 'xai', 'grok-4.5', 'Grok 4.5', '', 'grok-4', 500000, NULL, true, true, true, 'llm', NULL, 999, '{}'::jsonb),
  ('xai:grok-4.6', 'xai', 'grok-4.6', 'Grok 4.6', '', 'grok-4', 500000, NULL, true, true, true, 'llm', NULL, 999, '{}'::jsonb),
  ('xai:grok-4.7', 'xai', 'grok-4.7', 'Grok 4.7', '', 'grok-4', 500000, NULL, true, true, true, 'llm', NULL, 999, '{}'::jsonb),
  ('xai:grok-build-0.1', 'xai', 'grok-build-0.1', 'Grok Build 0.1', '', 'grok', 131072, NULL, true, true, false, 'llm', NULL, 999, '{}'::jsonb)
ON CONFLICT DO NOTHING;

-- DeepSeek. (2 models)
INSERT INTO public.models (
  id, provider_id, model_id, display_name, description, family,
  context_window_tokens, max_output_tokens, supports_tools, supports_vision,
  supports_reasoning, type, dimensions, sort_order, metadata
) VALUES
  ('deepseek:deepseek-flash', 'deepseek', 'deepseek-flash', 'DeepSeek Flash', '', 'deepseek-chat', 1000000, 393216, true, true, true, 'llm', NULL, 999, '{}'::jsonb),
  ('deepseek:deepseek-v4-pro', 'deepseek', 'deepseek-v4-pro', 'DeepSeek V4 Pro', '', 'deepseek-chat', 1000000, 393216, true, true, true, 'llm', NULL, 999, '{}'::jsonb)
ON CONFLICT DO NOTHING;

-- seeds/table-catalog.sql
--
-- The built-in Database tables: Snaglet's own `public` tables, listed in
-- `public.table_catalog` under stable `table-builtin-*` ids. Only builtin rows
-- are touched; custom (user-created) rows are never read or rewritten here.

INSERT INTO public.table_catalog (id, name, table_name, origin) VALUES
  ('table-builtin-docs', 'Docs', 'docs', 'builtin'),
  ('table-builtin-containers', 'Containers', 'containers', 'builtin'),
  ('table-builtin-hooks', 'Hooks', 'hook_registrations', 'builtin'),
  ('table-builtin-tools', 'Tools', 'tools', 'builtin'),
  ('table-builtin-files', 'Files', 'files', 'builtin'),
  ('table-builtin-images', 'Images', 'images', 'builtin'),
  ('table-builtin-threads', 'Threads', 'threads', 'builtin'),
  ('table-builtin-agents', 'Agents', 'agents', 'builtin'),
  ('table-builtin-providers', 'Providers', 'providers', 'builtin'),
  ('table-builtin-models', 'Models', 'models', 'builtin'),
  ('table-builtin-credentials', 'Credentials', 'user_provider_credentials', 'builtin')
ON CONFLICT (id) DO UPDATE
  SET name = EXCLUDED.name,
      table_name = EXCLUDED.table_name
  WHERE public.table_catalog.origin = 'builtin';

-- Automations. Its own statement: an active custom table may already
-- hold the name, and the names are unique, so it is added only while free.
INSERT INTO public.table_catalog (id, name, table_name, origin)
SELECT 'table-builtin-automations', 'Automations', 'automations', 'builtin'
 WHERE to_regclass('public.automations') IS NOT NULL
   AND NOT EXISTS (
     SELECT 1 FROM public.table_catalog
      WHERE lower(name) = 'automations' AND state = 'active'
        AND id <> 'table-builtin-automations'
   )
ON CONFLICT (id) DO UPDATE
  SET name = EXCLUDED.name,
      table_name = EXCLUDED.table_name
  WHERE public.table_catalog.origin = 'builtin';

-- seeds/local-models.sql
--
-- The local-onnx embedder provider + nomic embedder model row, the MiniLM-L6
-- reranker model row, and the remote embedding backends marked inactive.
-- Statement order matters: runs after provider-snaglet-local.sql.

-- The local-onnx provider + the 768-dimension nomic embedder model.
INSERT INTO public.providers (
  id, name, description, website, api_docs, sort_order,
  default_metadata, base_url, type
) VALUES (
  'local-onnx',
  'Snaglet Local Embedder',
  'Built-in local embedding runtime (onnxruntime-node). Ships with nomic-embed-text-v1.5; no API key, no network.',
  NULL,
  NULL,
  12,
  '{}'::jsonb,
  NULL,
  'runtime'
) ON CONFLICT (id) DO UPDATE SET
  name = EXCLUDED.name,
  description = EXCLUDED.description,
  sort_order = EXCLUDED.sort_order,
  default_metadata = EXCLUDED.default_metadata,
  base_url = EXCLUDED.base_url,
  type = EXCLUDED.type,
  updated_at = NOW();

INSERT INTO public.models (
  id, provider_id, model_id, display_name, description, family,
  context_window_tokens, max_output_tokens, supports_tools, supports_vision,
  supports_reasoning, type, dimensions, sort_order, metadata
) VALUES (
  'model-8f21c9d4-6a35-5e0b-9c47-2de1a07b4f63',
  'local-onnx',
  'nomic-embed-text-v1.5',
  'Nomic Embed Text v1.5 (int8 ONNX)',
  'Local 768-dimension bi-encoder embedding model. Task prefixes (search_document:/search_query:) are applied by the embedder service.',
  'embedding',
  512,
  1,
  false,
  false,
  false,
  'embedding',
  768,
  10,
  '{
    "embedding": {
      "runtime": "onnxruntime-node",
      "architecture": "nomic-bert",
      "sourceModel": "nomic-ai/nomic-embed-text-v1.5",
      "modelFile": "~/.snaglet/models/embedders/nomic-embed-text-v1.5/onnx/model_quantized.onnx",
      "vocabFile": "~/.snaglet/models/embedders/nomic-embed-text-v1.5/vocab.txt",
      "tokenizerConfigFile": "~/.snaglet/models/embedders/nomic-embed-text-v1.5/tokenizer_config.json",
      "sha256": "b4342336debaea79de872370664b0aaeb67dea4605513d00ee236ea871a81f27",
      "maxSequenceTokens": 512,
      "defaultBatchSize": 8
    }
  }'::jsonb
) ON CONFLICT (provider_id, model_id) DO UPDATE SET
  display_name = EXCLUDED.display_name,
  description = EXCLUDED.description,
  family = EXCLUDED.family,
  context_window_tokens = EXCLUDED.context_window_tokens,
  max_output_tokens = EXCLUDED.max_output_tokens,
  supports_tools = EXCLUDED.supports_tools,
  supports_vision = EXCLUDED.supports_vision,
  supports_reasoning = EXCLUDED.supports_reasoning,
  type = EXCLUDED.type,
  dimensions = EXCLUDED.dimensions,
  sort_order = EXCLUDED.sort_order,
  metadata = EXCLUDED.metadata,
  is_active = TRUE,
  updated_at = NOW();

-- Remote embedding backends stay in the catalog, inactive.
UPDATE public.models
SET is_active = FALSE, updated_at = NOW()
WHERE type = 'embedding'
  AND provider_id <> 'local-onnx';

-- The MiniLM-L6 reranker model.
INSERT INTO public.models (
  id, provider_id, model_id, display_name, description, family,
  context_window_tokens, max_output_tokens, supports_tools, supports_vision,
  supports_reasoning, type, dimensions, sort_order, metadata
) VALUES (
  'model-7b3f2a91-5c48-5f1e-8d26-4a9e0c317b52',
  'snaglet-local',
  'ms-marco-MiniLM-L6-v2-qint8-arm64',
  'MiniLM L6 Reranker (qint8 ARM64)',
  'Local ONNX cross-encoder reranker for scoring workspace context candidates before they are injected into an agent turn.',
  'reranking',
  512,
  1,
  false,
  false,
  false,
  'reranker',
  NULL,
  10,
  '{
    "reranking": {
      "runtime": "onnxruntime-node",
      "architecture": "bert-cross-encoder",
      "sourceModel": "cross-encoder/ms-marco-MiniLM-L6-v2",
      "modelFile": "~/.snaglet/models/rerankers/ms-marco-MiniLM-L6-v2/onnx/model_qint8_arm64.onnx",
      "vocabFile": "~/.snaglet/models/rerankers/ms-marco-MiniLM-L6-v2/vocab.txt",
      "tokenizerConfigFile": "~/.snaglet/models/rerankers/ms-marco-MiniLM-L6-v2/tokenizer_config.json",
      "sha256": "3573b6b9593cb2f75987a31815d409ca3dd8808629118fd20451bb1a5d90cec7",
      "maxSequenceTokens": 512,
      "defaultBatchSize": 8
    }
  }'::jsonb
) ON CONFLICT (provider_id, model_id) DO UPDATE SET
  display_name = EXCLUDED.display_name,
  description = EXCLUDED.description,
  family = EXCLUDED.family,
  context_window_tokens = EXCLUDED.context_window_tokens,
  max_output_tokens = EXCLUDED.max_output_tokens,
  supports_tools = EXCLUDED.supports_tools,
  supports_vision = EXCLUDED.supports_vision,
  supports_reasoning = EXCLUDED.supports_reasoning,
  type = EXCLUDED.type,
  dimensions = EXCLUDED.dimensions,
  sort_order = EXCLUDED.sort_order,
  metadata = EXCLUDED.metadata,
  is_active = TRUE,
  updated_at = NOW();

--
-- Feature flags: product-exposure switches (not authorization policy). A flag
-- ships off until explicitly enabled; hub_home (the Home pane) ships on.
--

INSERT INTO public.feature_flags (id, name, enabled) VALUES
  ('feature-flag-cli-pane-ui', 'cli_pane_ui', false),
  ('feature-flag-fallback-credentials', 'fallback_credentials', false),
  ('feature-flag-hub-home', 'hub_home', true),
  ('feature-flag-local-model-removal-ui', 'local_model_removal_ui', false);
