# Fix the root bottleneck

Prefer fixing the root bottleneck over masking it with timeouts, fallbacks, or
degraded modes. Extra wait time or a quieter path can make the symptom disappear
while the cause stays. A workaround that hides slowness is acceptable only as a
temporary step with a follow-up to fix the cause.

## Related

- [Fail loudly at the right layer](./fail-loudly.md)
