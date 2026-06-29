#!/usr/bin/env python3
import copy
import hashlib
import json
import sys
from datetime import datetime
from pathlib import Path
from zoneinfo import ZoneInfo


ACTIONS = {
    "NO_ACTION",
    "OWNER_REVIEW",
    "DRAFT_FOLLOW_UP",
    "REQUEST_CRM_UPDATE",
    "RECONCILE_EVIDENCE",
    "DISQUALIFY_REVIEW",
}
EVIDENCE_STATES = {"ok", "insufficient_evidence", "contradicted"}
STALE_STATES = {"fresh", "due_today", "stale", "blocked_by_contradiction", "unknown"}


class ValidationError(Exception):
    def __init__(self, code, message):
        self.code = code
        super().__init__(message)


def canonical_bytes(value):
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode()


def sha256_bytes(value):
    return hashlib.sha256(value).hexdigest()


def payload_bytes(value):
    if isinstance(value, str):
        return value.encode()
    return canonical_bytes(value)


def parse_time(value, code):
    if value is None:
        return None
    try:
        return datetime.fromisoformat(str(value).replace("Z", "+00:00"))
    except ValueError as exc:
        raise ValidationError(code, f"bad timestamp: {value}") from exc


def local_date(value, tz):
    dt = parse_time(value, "BAD_TIMESTAMP")
    return None if dt is None else dt.astimezone(tz).date()


def require_map(value, code, label):
    if not isinstance(value, dict):
        raise ValidationError(code, f"{label} must be an object")
    return value


def require_list(value, code, label):
    if not isinstance(value, list):
        raise ValidationError(code, f"{label} must be a list")
    return value


def collect_fact_ids(value):
    found = []
    if isinstance(value, dict):
        for k, v in value.items():
            if k == "fact_ids":
                found.extend(require_list(v, "BAD_FACT_IDS", "fact_ids"))
            else:
                found.extend(collect_fact_ids(v))
    elif isinstance(value, list):
        for item in value:
            found.extend(collect_fact_ids(item))
    return found


def build_facts(data):
    facts = {}
    for source in require_list(data.get("sources"), "BAD_SOURCES", "sources"):
        source = require_map(source, "BAD_SOURCE", "source")
        got = sha256_bytes(payload_bytes(source.get("payload")))
        if got != source.get("sha256"):
            raise ValidationError("SHA_MISMATCH", f"{source.get('source_id')} sha mismatch")
        for fact in require_list(source.get("facts"), "BAD_FACTS", "facts"):
            fact = require_map(fact, "BAD_FACT", "fact")
            fact_id = fact.get("fact_id")
            if not fact_id:
                raise ValidationError("BAD_FACT", "fact_id missing")
            facts[fact_id] = fact
    return facts


def validate_fact_refs(row, facts):
    for fact_id in collect_fact_ids(row):
        if fact_id not in facts:
            raise ValidationError("MISSING_FACT", f"missing fact: {fact_id}")


def validate_row_hash(row):
    integrity = require_map(row.get("integrity"), "ROW_SHA_MISMATCH", "integrity")
    expected = integrity.get("canonical_row_sha256")
    clone = copy.deepcopy(row)
    clone.setdefault("integrity", {}).pop("canonical_row_sha256", None)
    got = sha256_bytes(canonical_bytes(clone))
    if got != expected:
        raise ValidationError("ROW_SHA_MISMATCH", f"{row.get('row_id')} hash mismatch")


def validate_action(row):
    action = row.get("recommended_next_action", {}).get("action")
    if action not in ACTIONS:
        raise ValidationError("INVALID_ACTION_ENUM", f"invalid action: {action}")
    return action


def validate_status_values(row):
    status = require_map(row.get("computed_status"), "BAD_STATUS", "computed_status")
    if status.get("evidence_state") not in EVIDENCE_STATES:
        raise ValidationError("BAD_STATUS", "bad evidence_state")
    if status.get("stale_state") not in STALE_STATES:
        raise ValidationError("BAD_STATUS", "bad stale_state")


def validate_genericity(row, action):
    if action in {"NO_ACTION", "RECONCILE_EVIDENCE"}:
        return
    trigger = row.get("company_specific_trigger", {}).get("fact_ids") or []
    bottleneck = row.get("revenue_or_process_bottleneck", {}).get("fact_ids") or []
    action_facts = row.get("recommended_next_action", {}).get("fact_ids") or []
    if not trigger or not bottleneck:
        raise ValidationError("GENERIC_RECOMMENDATION", "missing trigger or bottleneck facts")
    if not (set(trigger) & set(action_facts)) or not (set(bottleneck) & set(action_facts)):
        raise ValidationError("GENERIC_RECOMMENDATION", "action must cite trigger and bottleneck")


def validate_contradictions(row, action):
    if not row.get("contradictions"):
        return
    status = row["computed_status"]
    ok = (
        status.get("evidence_state") == "contradicted"
        and status.get("stale_state") == "blocked_by_contradiction"
        and action == "RECONCILE_EVIDENCE"
    )
    if not ok:
        raise ValidationError("CONTRADICTION_NOT_BLOCKING", "contradiction must block action")


def expected_stale_state(row, policy, snapshot_at):
    status = row["computed_status"]
    if status.get("evidence_state") == "contradicted":
        return "blocked_by_contradiction"
    deal = require_map(row.get("deal"), "BAD_DEAL", "deal")
    if not deal.get("active", False):
        return "fresh"
    tz = ZoneInfo(policy.get("timezone", "America/Sao_Paulo"))
    today = local_date(snapshot_at, tz)
    dates = require_map(row.get("dates"), "BAD_DATES", "dates")
    due = local_date(dates.get("next_step_due_at"), tz)
    seller = local_date(dates.get("last_verified_seller_touch_at"), tz)
    buyer = local_date(dates.get("last_verified_buyer_reply_at"), tz)
    if due == today:
        return "due_today"
    if due and today > due:
        return "stale"
    if buyer and (not seller or buyer > seller):
        return "stale" if (today - buyer).days >= policy["buyer_reply_unanswered_after_calendar_days"] else "fresh"
    if seller and (not buyer or seller >= buyer):
        return "stale" if (today - seller).days >= policy["seller_touch_no_buyer_reply_after_calendar_days"] else "fresh"
    return "stale"


def validate_stale_state(row, policy, snapshot_at):
    expected = expected_stale_state(row, policy, snapshot_at)
    actual = row["computed_status"].get("stale_state")
    if actual != expected:
        raise ValidationError("STALE_STATE_INCORRECT", f"expected {expected}, got {actual}")


def validate_row(row, facts, policy, snapshot_at):
    row = require_map(row, "BAD_ROW", "row")
    validate_fact_refs(row, facts)
    validate_row_hash(row)
    validate_status_values(row)
    action = validate_action(row)
    validate_contradictions(row, action)
    validate_genericity(row, action)
    validate_stale_state(row, policy, snapshot_at)


def validate(data):
    require_map(data, "BAD_LEDGER", "ledger")
    if data.get("schema_version") != 1:
        raise ValidationError("BAD_SCHEMA_VERSION", "schema_version must be 1")
    snapshot_at = data.get("snapshot_at")
    policy = require_map(data.get("stale_policy"), "BAD_STALE_POLICY", "stale_policy")
    facts = build_facts(data)
    for row in require_list(data.get("rows"), "BAD_ROWS", "rows"):
        validate_row(row, facts, policy, snapshot_at)


def main():
    if len(sys.argv) != 2:
        print("usage: verify_hd_followup_ledger.py LEDGER.json", file=sys.stderr)
        return 2
    data = json.loads(Path(sys.argv[1]).read_text())
    try:
        validate(data)
    except ValidationError as exc:
        print(exc.code, str(exc), file=sys.stderr)
        return 1
    print("PASS")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
