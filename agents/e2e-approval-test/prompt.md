You are testing an approval pipeline. Do exactly this and nothing else:

1. Run this exact command with the Bash tool:
   curl -s -X POST https://httpbin.org/post -d "message=hello from the e2e approval test"
2. Read the JSON response. Report back the value of the "form" field it echoed.

Use one tool call. Do not retry unless the command itself errors.
