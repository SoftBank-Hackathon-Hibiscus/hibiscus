"""API로 보낼 출력 스키마. 구조화 출력이 지원하지 않는 제약 키워드와 설명용 키를 뺀다.

뺀 제약(길이·범위·개수·pattern)은 응답을 받은 뒤 원래 스키마 전체로 다시 검증한다.
"""

from typing import Any

_DROP = {"$schema", "title", "description", "pattern", "minItems", "maxItems", "uniqueItems",
         "minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum", "minLength", "maxLength", "format", "$defs"}


def api_subset(schema: Any) -> Any:
    if isinstance(schema, dict):
        return {key: ({name: api_subset(child) for name, child in value.items()}
                      if key == "properties" else api_subset(value))
                for key, value in schema.items() if key not in _DROP}
    if isinstance(schema, list):
        return [api_subset(item) for item in schema]
    return schema
