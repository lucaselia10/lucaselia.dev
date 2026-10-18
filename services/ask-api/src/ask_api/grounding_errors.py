"""Internal failures for the future grounded-answer path.

These messages are safe to log in tests. HTTP responses must not return them,
and they must not include provider errors, prompts, paths, or AWS identifiers.
"""


class GroundingError(Exception):
    """A grounding failure whose text stays inside the service."""


class RetrievalUnavailable(GroundingError):
    """The retriever could not return chunks."""

    def __init__(self) -> None:
        super().__init__("Retrieval is unavailable.")


class GenerationUnavailable(GroundingError):
    """The generator could not produce a draft."""

    def __init__(self) -> None:
        super().__init__("Generation is unavailable.")


class MalformedGeneratedOutput(GroundingError):
    """Model output did not match the grounded-answer contract."""

    def __init__(self) -> None:
        super().__init__("Generated output is malformed.")


class UngroundedGeneratedOutput(GroundingError):
    """Model output cited something that was not retrieved."""

    def __init__(self) -> None:
        super().__init__("Generated output is not grounded.")
