#!/usr/bin/env python3
"""Standard-library ontology blueprint builder. No models, npm packages or network.

This authoring tool expands schema metadata and checks keys/references. The web
server's shared validator remains authoritative for advanced constraints/contracts.
"""
import argparse
import copy
import json
import re
import sys
import uuid

BASE_TYPES = set('string integer short date timestamp boolean byte long float double decimal vector array struct mediaReference timeSeries geotemporalSeries attachment geopoint geoshape marking cipher'.split())
KEY_TYPES = set('string integer short byte long date timestamp boolean'.split())
COLORS = ['#54b5af', '#7399d5', '#e5a34f', '#9a8dde', '#dc7880', '#a9b666']
EXTENSIONS = ['sharedProperties', 'interfaces', 'valueTypes', 'groups', 'actionTypes', 'functions']


def fail(message):
    raise ValueError(message)


def api(value):
    if not isinstance(value, str) or not re.fullmatch(r'[A-Za-z][A-Za-z0-9_]{0,63}', value) or value in ('constructor', 'prototype', '__proto__'):
        fail('안전한 API 이름이 필요합니다.')
    return value


def obj(value, allowed=None):
    if not isinstance(value, dict):
        fail('객체가 필요합니다.')
    if allowed is not None and set(value) - set(allowed):
        fail('정의되지 않은 필드입니다.')
    return value


def items(value, maximum=40, minimum=0):
    if not isinstance(value, list) or not minimum <= len(value) <= maximum:
        fail('배열 길이가 올바르지 않습니다.')
    return value


def text(value, maximum=2000, empty=False):
    if not isinstance(value, str) or len(value) > maximum or (not empty and not value.strip()):
        fail('문자열 길이가 올바르지 않습니다.')
    return value.strip()


def unique(values):
    result = {api(item.get('apiName')): item for item in values}
    if len(result) != len(values):
        fail('중복 API 이름입니다.')
    return result


def names(value):
    result = [api(name) for name in items(value or [])]
    if len(set(result)) != len(result):
        fail('중복 참조입니다.')
    return result


def choice(value, allowed):
    if value not in allowed:
        fail('허용되지 않은 설정 값입니다.')
    return value


def property_definition(value, nested=False):
    raw = obj(value, 'apiName displayName description baseType required valueSource visibility sharedProperty valueType elementType fields constraints renderHints typeClasses'.split())
    name = api(raw.get('apiName'))
    kind = choice(raw.get('baseType'), BASE_TYPES)
    source = choice(raw.get('valueSource') or 'evidence', ['evidence', 'documentId', 'documentName', 'evidenceId'])
    if source != 'evidence' and (kind != 'string' or nested):
        fail('메타데이터 속성은 최상위 String이어야 합니다.')
    if nested and kind in ('array', 'struct'):
        fail('Struct 내부의 중첩 Array·Struct는 지원하지 않습니다.')
    required = raw.get('required', False)
    if not isinstance(required, bool):
        fail('required는 boolean이어야 합니다.')
    result = dict(apiName=name, displayName=text(raw.get('displayName', name), 100), description=text(raw.get('description', ''), empty=True), baseType=kind,
                  required=required, valueSource=source, visibility=choice(raw.get('visibility', 'normal'), ['normal', 'prominent', 'hidden']),
                  renderHints=items(raw.get('renderHints', []), 10), typeClasses=items(raw.get('typeClasses', []), 20))
    for field in ('sharedProperty', 'valueType'):
        if raw.get(field) is not None:
            result[field] = api(raw[field])
    if kind == 'array':
        result['elementType'] = choice(raw.get('elementType'), BASE_TYPES - {'array', 'struct'})
    elif raw.get('elementType') is not None:
        fail('elementType은 Array 전용입니다.')
    if kind == 'struct':
        result['fields'] = [property_definition(field, True) for field in items(raw.get('fields'), 20, 1)]
        unique(result['fields'])
    elif raw.get('fields'):
        fail('fields는 Struct 전용입니다.')
    if raw.get('constraints') is not None:
        constraints = obj(raw['constraints'], 'enum minimum maximum minLength maxLength pattern format uniqueItems'.split())
        result['constraints'] = {key: value for key, value in constraints.items() if value is not None}
    return result


def build(value):
    raw = copy.deepcopy(obj(value))
    if 'blueprintVersion' in raw:
        if raw.pop('blueprintVersion') != '1.0':
            fail('지원하지 않는 설계도 버전입니다.')
        obj(raw, ['apiName', 'displayName', 'description', 'objectTypes', 'linkTypes', 'processing', 'sourceMappings', 'extensions'])
        extensions = obj(raw.pop('extensions', None) or {}, EXTENSIONS)
        raw.update(extensions)
    obj(raw, 'schemaVersion id version apiName displayName description status objectTypes linkTypes sharedProperties interfaces valueTypes groups actionTypes functions processing sourceMappings'.split())
    if raw.get('schemaVersion', '1.0') != '1.0':
        fail('지원하지 않는 온톨로지 버전입니다.')
    identifier = raw.get('id', 'ontology-' + str(uuid.uuid4()))
    if not isinstance(identifier, str) or not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9._-]{0,79}', identifier):
        fail('로컬 ID 형식이 올바르지 않습니다.')
    version = raw.get('version', 1)
    if isinstance(version, bool) or not isinstance(version, int) or not 1 <= version <= 9007199254740991:
        fail('양의 정수 버전이 필요합니다.')
    result = dict(schemaVersion='1.0', id=identifier, version=version, apiName=api(raw.get('apiName')), displayName=text(raw.get('displayName'), 150), description=text(raw.get('description', ''), 4000, True), status=choice(raw.get('status', 'active'), ['draft', 'active', 'deprecated']))
    types = []
    for index, value in enumerate(items(raw.get('objectTypes'), 12, 1)):
        item = obj(value, 'apiName displayName pluralDisplayName description primaryKey titleProperty identityScope properties color icon visibility status implementsInterfaces groups'.split())
        name = api(item.get('apiName'))
        properties = [property_definition(prop) for prop in items(item.get('properties'), 20, 1)]
        by_name = unique(properties)
        primary = api(item.get('primaryKey'))
        title = api(item.get('titleProperty'))
        for key in (primary, title):
            if key not in by_name or by_name[key]['baseType'] not in KEY_TYPES:
                fail('Primary/Title Key는 존재하는 스칼라 속성이어야 합니다.')
            by_name[key]['required'] = True
        color = item.get('color', COLORS[index % len(COLORS)])
        if not isinstance(color, str) or not re.fullmatch(r'#[0-9a-fA-F]{6}', color):
            fail('올바른 객체 색상이 필요합니다.')
        types.append(dict(apiName=name, displayName=text(item.get('displayName', name), 100), pluralDisplayName=text(item.get('pluralDisplayName', item.get('displayName', name)), 100),
                          description=text(item.get('description', ''), empty=True), primaryKey=primary, titleProperty=title,
                          identityScope=choice(item.get('identityScope', 'source' if primary == title and by_name[primary]['baseType'] == 'string' else 'ontology'), ['source', 'ontology']),
                          properties=properties, color=color, icon=text(item.get('icon', 'object'), 50), visibility=choice(item.get('visibility', 'normal'), ['normal', 'prominent', 'hidden']),
                          status=choice(item.get('status', 'active'), ['active', 'experimental', 'deprecated']), implementsInterfaces=names(item.get('implementsInterfaces')), groups=names(item.get('groups'))))
    type_map = unique(types)
    result['objectTypes'] = types
    links = []
    for value in items(raw.get('linkTypes', [])):
        item = obj(value, 'apiName displayName inverseDisplayName description sourceType targetType sourceCardinality targetCardinality visibility status'.split())
        name = api(item.get('apiName'))
        source, target = api(item.get('sourceType')), api(item.get('targetType'))
        if source not in type_map or target not in type_map:
            fail('관계가 참조하는 객체 타입이 없습니다.')
        links.append(dict(apiName=name, displayName=text(item.get('displayName', name), 100), inverseDisplayName=text(item.get('inverseDisplayName', item.get('displayName', name)), 100),
                          description=text(item.get('description', ''), empty=True), sourceType=source, targetType=target,
                          sourceCardinality=choice(item.get('sourceCardinality'), ['one', 'many']), targetCardinality=choice(item.get('targetCardinality'), ['one', 'many']),
                          visibility=choice(item.get('visibility', 'normal'), ['normal', 'prominent', 'hidden']), status=choice(item.get('status', 'active'), ['active', 'experimental', 'deprecated'])))
    link_map = unique(links)
    result['linkTypes'] = links
    for field in EXTENSIONS:
        result[field] = items(raw.get(field, []))
        unique(result[field])
    result['sharedProperties'] = [property_definition(prop) for prop in result['sharedProperties']]
    for field in ('actionTypes', 'functions'):
        for item in result[field]:
            if item.get('executable', False) is not False or item.get('status', 'draft') != 'draft':
                fail('Action·Function은 실행할 수 없는 draft 선언만 허용합니다.')
            item.update(executable=False, status='draft')
    processing = obj(raw.get('processing', {}), ['textStrategy', 'jevEligibleLinkTypes', 'decisionRules', 'rationale'])
    result['processing'] = dict(textStrategy=choice(processing.get('textStrategy', 'codex'), ['codex', 'jev-assisted']), jevEligibleLinkTypes=names(processing.get('jevEligibleLinkTypes')), decisionRules=items(processing.get('decisionRules', []), 8), rationale=text(processing.get('rationale', '복잡하거나 검증되지 않은 판단은 Codex로 처리합니다.')))
    if any(name not in link_map for name in result['processing']['jevEligibleLinkTypes']):
        fail('Jev가 참조하는 관계 타입이 없습니다.')
    if result['processing']['textStrategy'] == 'codex' and result['processing']['jevEligibleLinkTypes']:
        fail('Codex 전략에는 Jev Link Type을 지정할 수 없습니다.')
    mappings = []
    for value in items(raw.get('sourceMappings', []), 30):
        item = obj(value, ['sourceName', 'format', 'objectType', 'columns', 'identityColumns', 'semanticColumns', 'retainedColumns', 'relations'])
        target = api(item.get('objectType'))
        if target not in type_map:
            fail('컬럼 매핑의 객체 타입이 없습니다.')
        properties = unique(type_map[target]['properties'])
        columns = []
        for column in items(item.get('columns'), 20):
            column = {'column': column, 'property': column} if isinstance(column, str) else obj(column, ['column', 'property'])
            name = api(column.get('property'))
            if name not in properties or properties[name]['valueSource'] != 'evidence':
                fail('매핑 속성이 없거나 메타데이터 속성을 컬럼에 매핑했습니다.')
            columns.append(dict(column=text(column.get('column'), 150), property=name))
        if len({column['column'] for column in columns}) != len(columns) or len({column['property'] for column in columns}) != len(columns):
            fail('중복 컬럼 매핑입니다.')
        identity = items(item.get('identityColumns', []), 5)
        semantic = items(item.get('semanticColumns', []), 20)
        retained = items(item.get('retainedColumns') or [], 200)
        if any(column not in [mapped['column'] for mapped in columns] for column in identity):
            fail('식별 컬럼을 속성에 매핑해야 합니다.')
        primary = type_map[target]['primaryKey']
        if properties[primary]['valueSource'] == 'evidence' and not any(mapped['property'] == primary and mapped['column'] in identity for mapped in columns):
            fail('원문 Primary Key는 식별 컬럼에 직접 매핑해야 합니다.')
        if set(retained) & (set(identity) | set(semantic) | {column['column'] for column in columns}):
            fail('원문 보존 컬럼이 분석 컬럼과 겹칩니다.')
        mappings.append(dict(sourceName=text(item.get('sourceName'), 300), format=choice(item.get('format'), ['csv', 'json', 'jsonl']), objectType=target,
                             columns=columns, identityColumns=identity, semanticColumns=semantic, retainedColumns=retained, relations=items(item.get('relations', []), 20)))
    result['sourceMappings'] = mappings
    return result


def template():
    def prop(name, kind='string'):
        return dict(apiName=name, displayName=name, baseType=kind, required=True, valueSource='evidence')
    return dict(blueprintVersion='1.0', apiName='CustomerOrders', displayName='고객과 주문', description='명시된 식별자로 고객과 주문을 연결합니다.', objectTypes=[
        dict(apiName='Customer', displayName='고객', primaryKey='customerId', titleProperty='name', identityScope='ontology', properties=[prop('customerId'), prop('name')]),
        dict(apiName='Order', displayName='주문', primaryKey='orderId', titleProperty='orderId', identityScope='ontology', properties=[prop('orderId'), prop('amount', 'double')])],
        linkTypes=[dict(apiName='placed', displayName='주문', sourceType='Customer', targetType='Order', sourceCardinality='one', targetCardinality='many')],
        sourceMappings=[dict(sourceName='orders.csv', format='csv', objectType='Customer', columns=['customerId', 'name'], identityColumns=['customerId'], relations=[dict(linkType='placed', targetType='Order', sourceColumn='orderId', targetProperty='orderId')]),
                        dict(sourceName='orders.csv', format='csv', objectType='Order', columns=['orderId', 'amount'], identityColumns=['orderId'])])


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('file', nargs='?', help='Blueprint/full definition JSON, or - for stdin')
    parser.add_argument('--template', choices=['commerce'])
    args = parser.parse_args()
    if args.template:
        value = template()
    else:
        if not args.file:
            parser.error('설계도 파일 또는 --template commerce를 지정해주세요.')
        try:
            if args.file == '-':
                data = sys.stdin.buffer.read(2_000_001)
            else:
                with open(args.file, 'rb') as source:
                    data = source.read(2_000_001)
        except OSError:
            fail('설계도 JSON 파일을 읽을 수 없습니다.')
        if len(data) > 2_000_000:
            fail('설계도 JSON은 최대 2MB입니다. 원본 업로드 제한이 아닙니다.')
        try:
            value = json.loads(data.decode('utf-8-sig'), parse_constant=lambda _: fail('유한한 JSON 수치가 필요합니다.'))
        except (json.JSONDecodeError, UnicodeDecodeError):
            fail('설계도 파일에 올바른 JSON이 필요합니다.')
        value = build(value)
    print(json.dumps(value, ensure_ascii=False, indent=2, allow_nan=False))


if __name__ == '__main__':
    sys.stdout.reconfigure(encoding='utf-8')
    sys.stderr.reconfigure(encoding='utf-8')
    try:
        main()
    except (ValueError, TypeError, KeyError, RecursionError):
        # No arbitrary source value, credential, traceback or source body in diagnostics.
        error = sys.exc_info()[1]
        print('온톨로지 생성 실패: ' + (str(error) if type(error) is ValueError else '설계도 구조를 확인해주세요.'), file=sys.stderr)
        sys.exit(1)
