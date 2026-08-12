"""Single source of the package version.

A leaf module on purpose: `client.py` needs the version to identify itself on every ingest
batch, and importing it from the package root would be circular (the root imports the client).
Kept in lockstep with pyproject.toml by the doc-drift checker.
"""

__version__ = "0.5.0"
