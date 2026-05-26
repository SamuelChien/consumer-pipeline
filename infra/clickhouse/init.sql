CREATE DATABASE IF NOT EXISTS consumer;

-- Skills master table
CREATE TABLE IF NOT EXISTS consumer.skills (
    id String,
    name String,
    description String,
    category String,
    secondary_category Nullable(String),
    tier String DEFAULT 'standard',
    risk String DEFAULT 'safe',
    author String DEFAULT 'unknown',
    version String DEFAULT '1.0.0',
    platforms Array(String),
    tags Array(String),
    allowed_tools Array(String),
    quality_score UInt8 DEFAULT 0,
    quality_grade String DEFAULT 'F',
    complexity_level String DEFAULT 'basic',
    body_length UInt32 DEFAULT 0,
    heading_count UInt16 DEFAULT 0,
    code_block_count UInt16 DEFAULT 0,
    keywords Array(String),
    source_collection String DEFAULT '',
    updated_at DateTime DEFAULT now()
) ENGINE = ReplacingMergeTree(updated_at)
ORDER BY id;

-- Skill dependencies
CREATE TABLE IF NOT EXISTS consumer.skill_dependencies (
    skill_id String,
    depends_on String,
    dependency_type String DEFAULT 'depends_on',
    confidence Float32 DEFAULT 0.5,
    created_at DateTime DEFAULT now()
) ENGINE = MergeTree()
ORDER BY (skill_id, depends_on);

-- Skill entities (tags, tools, technologies)
CREATE TABLE IF NOT EXISTS consumer.skill_entities (
    skill_id String,
    entity_name String,
    entity_type String,
    created_at DateTime DEFAULT now()
) ENGINE = MergeTree()
ORDER BY (entity_type, entity_name, skill_id);

-- Sessions analytics
CREATE TABLE IF NOT EXISTS consumer.sessions (
    session_id String,
    project String,
    primary_category String DEFAULT 'unknown',
    secondary_category Nullable(String),
    complexity_level String DEFAULT 'simple',
    message_count UInt32 DEFAULT 0,
    total_tokens UInt64 DEFAULT 0,
    input_tokens UInt64 DEFAULT 0,
    output_tokens UInt64 DEFAULT 0,
    cache_hit_rate Float32 DEFAULT 0,
    total_tool_calls UInt32 DEFAULT 0,
    unique_tools UInt16 DEFAULT 0,
    files_accessed UInt32 DEFAULT 0,
    duration_minutes Float32 DEFAULT 0,
    error_count UInt16 DEFAULT 0,
    session_date Date DEFAULT today(),
    created_at DateTime DEFAULT now()
) ENGINE = ReplacingMergeTree(created_at)
ORDER BY session_id;

-- Tool usage per session
CREATE TABLE IF NOT EXISTS consumer.session_tools (
    session_id String,
    tool_name String,
    call_count UInt32 DEFAULT 1,
    created_at DateTime DEFAULT now()
) ENGINE = MergeTree()
ORDER BY (tool_name, session_id);

-- File access per session
CREATE TABLE IF NOT EXISTS consumer.session_files (
    session_id String,
    file_path String,
    reads UInt16 DEFAULT 0,
    writes UInt16 DEFAULT 0,
    edits UInt16 DEFAULT 0,
    created_at DateTime DEFAULT now()
) ENGINE = MergeTree()
ORDER BY (file_path, session_id);

-- Materialized views for analytics

CREATE MATERIALIZED VIEW IF NOT EXISTS consumer.skills_by_category_mv
ENGINE = SummingMergeTree()
ORDER BY category
AS SELECT
    category,
    count() as skill_count,
    avg(quality_score) as avg_quality,
    avg(body_length) as avg_body_length
FROM consumer.skills
GROUP BY category;

CREATE MATERIALIZED VIEW IF NOT EXISTS consumer.sessions_daily_mv
ENGINE = SummingMergeTree()
ORDER BY (session_date, primary_category)
AS SELECT
    session_date,
    primary_category,
    count() as session_count,
    sum(total_tokens) as total_tokens,
    sum(total_tool_calls) as total_tool_calls,
    avg(duration_minutes) as avg_duration
FROM consumer.sessions
GROUP BY session_date, primary_category;
