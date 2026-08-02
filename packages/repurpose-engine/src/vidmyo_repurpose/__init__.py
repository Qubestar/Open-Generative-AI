"""Vidmyo Repurpose versioned worker contracts."""

from .contracts import (
    MANIFEST_VERSION,
    PROTOCOL_VERSION,
    INGEST_ARTIFACT_VERSION,
    TRANSCRIPT_ARTIFACT_VERSION,
    ContractValidationError,
    load_schema,
    validate_document,
    validate_event_stream,
)

__all__ = [
    "MANIFEST_VERSION",
    "PROTOCOL_VERSION",
    "INGEST_ARTIFACT_VERSION",
    "TRANSCRIPT_ARTIFACT_VERSION",
    "ContractValidationError",
    "load_schema",
    "validate_document",
    "validate_event_stream",
]
