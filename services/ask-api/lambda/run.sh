#!/bin/bash
# The ask function's handler script. The Lambda Web Adapter layer's /opt/bootstrap (set as
# AWS_LAMBDA_EXEC_WRAPPER) runs it in place of the Python runtime's own loop; the adapter,
# running as an extension, forwards each invocation to this server on 127.0.0.1:8080.
# boto3 comes from the runtime's site-packages, not from this package.
set -eu
cd "${LAMBDA_TASK_ROOT}"
export PYTHONPATH="${LAMBDA_TASK_ROOT}${PYTHONPATH:+:${PYTHONPATH}}"
exec python3 -m ask_api.production_app
