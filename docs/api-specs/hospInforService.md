# 건강보험심사평가원 병원정보서비스 OpenAPI 활용가이드

## 문서 정보

엔드포인트: https://apis.data.go.kr/B551182/hospInfoServicev2
일반 인증키 : c43f9b325b7abfae1beccd4690b7b907d80afe4de2152a3d30a4d4bf49c9660c

---

| 항목 | 내용 |
|---|---|
| 프로젝트 | 공공데이터 개방·공유·활용 체계 개발 |
| 내용 | Open API 서비스 사용법, 서비스 목록 및 명세 |
| 파일명 | OpenAPI활용가이드_건강보험심사평가원(병원정보서비스) |

### 개정 이력

| 버전 | 변경일 | 변경 사유 | 변경 내용 |
|---|---|---|---|
| 1.0 | 2014-11-25 | 최초작성 | 최초작성 |
| 1.1 | 2016-12-14 | G/W 버전 | G/W 버전 변경 |
| 1.2 | 2021-06-16 | 서비스 변경 | 서비스 변경 |

---

## 1. 서비스 개요

### 1.1 OpenAPI 서비스 개요

**배경 및 필요성**
- 공공데이터는 공공영역을 넘어 사적 영역의 다양한 사회적·경제적 가치 창출 활동에 활용될 수 있는 잠재성 내재
- 민간 영역의 자원과 융복합을 통한 신규 비즈니스 창출이 용이한 형태의 공공데이터 개방·공유·활용 대한 수요 증대

**OpenAPI 서비스 설명**
건강보험심사평가원에서 제공하고 있는 정보데이터를 공공 및 민간이 활용할 수 있도록 표준화 방식으로 개방한 공유서비스

### 1.2 기대효과
병원정보서비스의 병원목록을 일반 개발자에 공개하여 대국민의 접근성을 높이는 서비스

---

## 2. 서비스 사용

### 2.1 서비스 Key 발급 및 활용

#### 가. 서비스 Key 발급 (인증신청 및 발급)

공유자원포털(http://data.go.kr) 활용자 절차:
1. 활용신청하고자 하는 API를 검색하여 제목을 클릭한다.
2. 서비스정보와 상세기능 확인 후, 활용신청 버튼을 클릭한다.
3. 활용신청하고자 하는 내역을 입력하고, 활용할 API를 선택하여 신청 버튼을 클릭한다.

#### 나. 서비스 인증키 활용

**REST 방식의 서비스키(인증키) 활용**

인증키 활용 및 API 호출방법:
- 개발계정은 일 1,000건의 트래픽을 제공합니다.
- 자동승인으로 활용신청 후, 약 30분 이후에 사용이 가능합니다. (공공데이터포털과 건강보험심사평가원 동기화)

**1) REST방식의 URL 요청 예시**

응답표준은 XML이며, JSON을 요청할 경우 `&_type=json`을 추가하여 요청합니다.

```
Json 요청 : http://apis.data.go.kr/B551182/hospInfoService1/getHospBasisList1?pageNo=1&numOfRows=10&_type=json
```

**2) 서비스키(인증키) 인코딩방법**

```java
String myKey = "발급받은 인증키";
String ServiceKey = URLEncoder.encode(myKey, "UTF-8");
```

**3) 요청파라미터에 서비스명 기재**

INPUT 파라미터가 한글일 경우 인코딩 처리가 필요

```jsp
<%@ page language="java" contentType="text/html; charset=UTF-8" pageEncoding="UTF-8"%>
String searchText = URLEncoder.encode("건강보험심사평가원", "UTF-8");

http://apis.data.go.kr/B551182/hospInfoService1/getHospBasisList1?pageNo=1&numOfRows=10&ServiceKey=ServiceKey&searchKey=searchText
```

#### 메시지 코드표 (공공데이터포털제공)

| 에러코드 | 에러메세지 | 설명 |
|---|---|---|
| 0 | NORMAL_CODE | 정상 |
| 1 | APPLICATION_ERROR | 어플리케이션 에러 |
| 2 | DB_ERROR | 데이터베이스 에러 |
| 3 | NODATA_ERROR | 데이터없음 에러 |
| 4 | HTTP_ERROR | HTTP 에러 |
| 5 | SERVICETIMEOUT_ERROR | 서비스 연결실패 에러 |
| 10 | INVALID_REQUEST_PARAMETER_ERROR | 잘못된 요청 파라메터 에러 |
| 11 | NO_MANDATORY_REQUEST_PARAMETERS_ERROR | 필수요청 파라메터가 없음 |
| 12 | NO_OPENAPI_SERVICE_ERROR | 해당 오픈API서비스가 없거나 폐기됨 |
| 20 | SERVICE_ACCESS_DENIED_ERROR | 서비스 접근거부 |
| 21 | TEMPORARILY_DISABLE_THE_SERVICEKEY_ERROR | 일시적으로 사용할 수 없는 서비스 키 |
| 22 | LIMITED_NUMBER_OF_SERVICE_REQUESTS_EXCEEDS_ERROR | 서비스 요청제한횟수 초과에러 |
| 30 | SERVICE_KEY_IS_NOT_REGISTERED_ERROR | 등록되지 않은 서비스키 |
| 31 | DEADLINE_HAS_EXPIRED_ERROR | 기한만료된 서비스키 |
| 32 | UNREGISTERED_IP_ERROR | 등록되지 않은 IP |
| 33 | UNSIGNED_CALL_ERROR | 서명되지 않은 호출 |
| 99 | UNKNOWN_ERROR | 기타에러 |

---

## 3. 서비스 목록

| 순번 | 서비스 ID | 서비스명(국문) | 서비스명(영문) |
|---|---|---|---|
| 1 | SC-OA-08-02 | 병원정보서비스 | HospInfoService1 |

※ 오퍼레이션 목록은 각각의 서비스 명세에 표기

---

## 4. 서비스 명세

## 4.1 병원정보서비스

### 가. 서비스 개요

| 구분 | 항목 | 내용 |
|---|---|---|
| 서비스 정보 | 서비스 ID | SC-OA-08-02 |
| | 서비스명(국문) | 병원정보서비스 |
| | 서비스명(영문) | HospInfoService1 |
| | 서비스 설명 | 건강보험심사평가원에서 관리하는 병원 정보 조회 (저작권에 위배되지 않는 정보) |
| 서비스 보안 | 서비스 인증/권한 | [O] 서비스 Key &nbsp;&nbsp;[ ] 인증서(GPKI) &nbsp;&nbsp;[ ] Basic(ID/PW) &nbsp;&nbsp;[ ] 없음 &nbsp;&nbsp;[ ] WS-Security |
| | 메시지 레벨 암호화 | [ ] 전자서명  [ ] 암호화  [O] 없음 |
| | 전송 레벨 암호화 | [ ] SSL  [O] 없음 |
| 적용 기술 수준 | 인터페이스 표준 | [ ] SOAP 1.2 (RPC-Encoded, Document Literal, Document Literal Wrapped)  /  [O] REST (GET, POST, PUT, DELETE)  /  [ ] RSS 1.0 [ ] RSS 2.0 [ ] Atom 1.0 [ ] 기타 |
| | 교환 데이터 표준 | [O] XML  [ ] JSON  [ ] MIME  [ ] MTOM |
| 서비스 URL | 개발환경 | `http://apis.data.go.kr/B551182/hospInfoService1` |
| | 운영환경 | `http://apis.data.go.kr/B551182/hospInfoService1` |
| 서비스 WADL | 개발환경 | N/A |
| | 운영환경 | N/A |
| 서비스 배포 정보 | 서비스 버전 | 1.2 |
| | 유효일자 / 배포일자 | N/A / N/A |
| | 서비스 이력 | N/A |
| 메시지 교환 유형 | | [O] Request-Response  [ ] Publish-Subscribe  [ ] Fire-and-Forget  [ ] Notification |
| 메시지 로깅 수준 | | 성공: [O] Header [ ] Body &nbsp;&nbsp; 실패: [O] Header [O] Body |
| 사용 제약 사항 (비고) | | N/A |

### 나. 오퍼레이션 목록

| 일련번호 | 서비스명(국문) | 오퍼레이션명(영문) | 오퍼레이션명(국문) | 메시지명(영문) |
|---|---|---|---|---|
| 1 | 병원정보서비스 | getHospBasisList1 | 병원기본목록 | N/A |

#### [병원기본목록] 오퍼레이션 명세

| 항목 | 내용 |
|---|---|
| 오퍼레이션 번호 | 1 |
| 오퍼레이션명(국문) | 병원기본목록 |
| 오퍼레이션명(영문) | getHospBasisList1 |
| 오퍼레이션 유형 | 조회(목록) |
| 오퍼레이션 설명 | 병원 기본정보 제공 (저작권에 위배되지 않는 정보) |
| Call Back URL | `http://apis.data.go.kr/B551182/hospInfoService1/getHospBasisList1` |
| 최대 메시지 사이즈 | 4000 bytes |
| 평균 응답 시간 | 500 ms |
| 초당 최대 트랜잭션 | 30 tps |

##### 요청 메시지 명세

※ 항목구분 : 필수(1), 옵션(0), 1건 이상 복수건(1..n), 0건 또는 복수건(0..n)

| 항목명(영문) | 항목명(국문) | 항목크기 | 항목구분 | 샘플데이터 | 항목설명 |
|---|---|---|---|---|---|
| ServiceKey | 서비스 인증키 | 400 | 1 | 공공데이터포털에서 받은 인증키 | 공공데이터포털에서 받은 인증키 |
| pageNo | 페이지 번호 | 5 | 0 | 1 | 페이지 번호 |
| numOfRows | 한 페이지 결과 수 | 2 | 0 | 10 | 한 페이지 결과 수 |
| sidoCd | 시도코드 | 6 | 0 | 110000 | 시도코드 |
| sgguCd | 시군구코드 | 6 | 0 | 110019 | 시군구코드 |
| emdongNm | 읍면동명 | 150 | 0 | 신내동 | 읍면동명 |
| yadmNm | 병원명 (UTF-8 인코딩 필요) | 150 | 0 | 서울의료원 | 병원명 |
| zipCd | 분류코드 | 4 | 0 | 2010 | 2010:종합병원, 2030:병원, 2040:요양병원, 2050:치과, 2060:한방, 2070:의원, 2080:보건기관, 2090:조산원 |
| clCd | 종별코드 | 2 | 0 | 11 | 01:상급종합병원, 11:종합병원, 21:병원, 28:요양병원, 29:정신병원, 31:의원, 41:치과병원, 51:치과의원, 61:조산원, 71:보건소, 72:보건지소, 73:보건진료소, 75:보건의료원, 92:한방병원, 93:한의원 |
| dgsbjtCd | 진료과목코드 | 2 | 0 | 01 | 00:일반의, 01:내과, 02:신경과, 03:정신건강의학과, 04:외과, 05:정형외과, 06:신경외과, 07:흉부외과, 08:성형외과, 09:마취통증의학과, 10:산부인과, 11:소아청소년과, 12:안과, 13:이비인후과, 14:피부과, 15:비뇨의학과, 16:영상의학과, 17:방사선종양학과, 18:병리과, 19:진단검사의학과, 20:결핵과, 21:재활의학과, 22:핵의학과, 23:가정의학과, 24:응급의학과, 25:직업환경의학과, 26:예방의학과, 50:구강악안면외과, 51:치과보철과, 52:치과교정과, 53:소아치과, 54:치주과, 55:치과보존과, 56:구강내과, 57:영상치의학과, 58:구강병리과, 59:예방치과, 61:통합치의학과, 80:한방내과, 81:한방부인과, 82:한방소아과, 83:한방안이비인후피부과, 84:한방신경정신과, 85:침구과, 86:한방재활의학과, 87:사상체질과, 88:한방응급 |
| xPos | x좌표 | 18 | 0 | 127.09854004628151 | x좌표(소수점 15) |
| yPos | y좌표 | 18 | 0 | 37.6132113197367 | y좌표(소수점 15) |
| radius | 반경 | 10 | 0 | 3000 | 단위 : 미터(m) |

##### 응답 메시지 명세

※ 항목구분 : 필수(1), 옵션(0), 1건 이상 복수건(1..n), 0건 또는 복수건(0..n)

| 항목명(영문) | 항목명(국문) | 항목크기 | 항목구분 | 샘플데이터 | 항목설명 |
|---|---|---|---|---|---|
| resultCode | 결과코드 | 5 | 1 | 00 | 결과코드 |
| resultMsg | 결과메시지 | 50 | 1 | NORMAL SERVICE. | 결과메시지 |
| numOfRows | 한 페이지 결과 수 | 2 | 0 | 10 | 한 페이지 결과 수 |
| pageNo | 페이지 번호 | 5 | 0 | 1 | 페이지 번호 |
| totalCount | 총건수 | 7 | 0 | 2 | 조회데이터의 총건수 |
| Items | 리스트 항목 | - | 1 | - | 리스트항목 |
| ㄴ Item | 세부 항목 | - | 0..n | - | 세부 항목 |
| ㄴㄴ ykiho | 암호화된 요양기호 | 400 | 1 | {생략} | 암호화 요양기호 |
| ㄴㄴ yadmNm | 병원명 | 150 | 0 | 서울특별시서울의료원 | 병원명 |
| ㄴㄴ clCd | 종별코드 | 2 | 0 | 11 | 종별코드 |
| ㄴㄴ clCdNm | 종별코드명 | 150 | 0 | 종합병원 | 종별코드명 |
| ㄴㄴ sidoCd | 시도코드 | 6 | 0 | 110000 | 시도코드 |
| ㄴㄴ sidoCdNm | 시도명 | 150 | 0 | 서울 | 시도명 |
| ㄴㄴ sgguCd | 시군구코드 | 6 | 0 | 110019 | 종별코드 |
| ㄴㄴ sgguCdNm | 시군구명 | 150 | 0 | 중랑구 | 시군구명 |
| ㄴㄴ emdongNm | 읍면동명 | 150 | 0 | 신내동 | 읍면동명 |
| ㄴㄴ postNo | 우편번호 | 6 | 0 | 02053 | 우편번호 |
| ㄴㄴ addr | 주소 | 500 | 0 | 서울특별시 중랑구 신내로 156 (신내동) | 주소 |
| ㄴㄴ telno | 전화번호 | 30 | 0 | 02-2276-7000 | 전화번호 |
| ㄴㄴ hospUrl | 홈페이지 | 500 | 0 | http://www.seoulmc.or.kr | 홈페이지 |
| ㄴㄴ estbDd | 개설일자 | 8 | 0 | 20110309 | 개설일자 |
| ㄴㄴ drTotCnt | 의사총수 | 14 | 0 | 227 | 의사총수 |
| ㄴㄴ mdeptGdrCnt | 의과일반의 인원수 | 22 | 0 | 0 | 의과일반의 인원수 |
| ㄴㄴ mdeptIntnCnt | 의과인턴 인원수 | 22 | 0 | 28 | 의과인턴 인원수 |
| ㄴㄴ mdeptResdntCnt | 의과레지던트 인원수 | 22 | 0 | 64 | 의과레지던트 인원수 |
| ㄴㄴ mdeptSdrCnt | 의과전문의 인원수 | 22 | 0 | 131 | 의과전문의 인원수 |
| ㄴㄴ detyGdrCnt | 치과일반의 인원수 | 22 | 0 | 1 | 치과일반의 인원수 |
| ㄴㄴ detyIntnCnt | 치과인턴 인원수 | 22 | 0 | 0 | 치과인턴 인원수 |
| ㄴㄴ detyResdntCnt | 치과레지던트 인원수 | 22 | 0 | 0 | 치과레지던트 인원수 |
| ㄴㄴ detySdrCnt | 치과전문의 인원수 | 22 | 0 | 2 | 치과전문의 인원수 |
| ㄴㄴ cmdcGdrCnt | 한방일반의 인원수 | 22 | 0 | 1 | - |
| ㄴㄴ cmdcIntnCnt | 한방인턴 인원수 | 22 | 0 | 0 | 한방인턴 인원수 |
| ㄴㄴ cmdcResdntCnt | 한방레지던트 인원수 | 22 | 0 | 0 | 한방레지던트 인원수 |
| ㄴㄴ cmdcSdrCnt | 한방전문의 인원수 | 22 | 0 | 0 | 한방전문의 인원수 |
| ㄴㄴ XPos | x좌표 | 18 | 0 | 127.09854004628151 | x좌표(소수점 13) |
| ㄴㄴ YPos | y좌표 | 18 | 0 | 37.6132113197367 | y좌표(소수점 13) |
| ㄴㄴ distance | 거리 | 10 | 0 | 0 | 단위 : 미터(m) |

##### 요청 / 응답 메시지 예제

**REST(URI) 요청 예시**

```
http://apis.data.go.kr/B551182/hospInfoService1/getHospBasisList1?sidoCd=110000&sgguCd=110019&emdongNm=신내동&yadmNm=서울의료원&zipCd=2010&clCd=11&xPos=127.09854004628151&yPos=37.6132113197367&radius=3000&ServiceKey=서비스키(인증키)
```

**응답 메시지 예시**

```xml
<response>
  <header>
    <resultCode>00</resultCode>
    <resultMsg>NORMAL SERVICE.</resultMsg>
  </header>
  <body>
    <items>
      <item>
        <addr>서울특별시 중랑구 신내로 156 (신내동)</addr>
        <clCd>11</clCd>
        <clCdNm>종합병원</clCdNm>
        <cmdcGdrCnt>1</cmdcGdrCnt>
        <cmdcIntnCnt>0</cmdcIntnCnt>
        <cmdcResdntCnt>0</cmdcResdntCnt>
        <cmdcSdrCnt>0</cmdcSdrCnt>
        <detyGdrCnt>1</detyGdrCnt>
        <detyIntnCnt>0</detyIntnCnt>
        <detyResdntCnt>0</detyResdntCnt>
        <detySdrCnt>2</detySdrCnt>
        <distance>0</distance>
        <drTotCnt>227</drTotCnt>
        <emdongNm>신내동</emdongNm>
        <estbDd>20110309</estbDd>
        <hospUrl>http://www.seoulmc.or.kr</hospUrl>
        <mdeptGdrCnt>0</mdeptGdrCnt>
        <mdeptIntnCnt>28</mdeptIntnCnt>
        <mdeptResdntCnt>64</mdeptResdntCnt>
        <mdeptSdrCnt>131</mdeptSdrCnt>
        <postNo>02053</postNo>
        <sgguCd>110019</sgguCd>
        <sgguCdNm>중랑구</sgguCdNm>
        <sidoCd>110000</sidoCd>
        <sidoCdNm>서울</sidoCdNm>
        <telno>02-2276-7000</telno>
        <XPos>127.09854004628151</XPos>
        <YPos>37.6132113197367</YPos>
        <yadmNm>서울특별시서울의료원</yadmNm>
        <ykiho>JDQ4MTg4MSM1MSMkMSMkMCMkODkkMzgxMzUxIzExIyQyIyQ3IyQwMCQyNjEyMjIjNjEjJDEjJDgjJDgz</ykiho>
      </item>
    </items>
    <numOfRows>10</numOfRows>
    <pageNo>1</pageNo>
    <totalCount>1</totalCount>
  </body>
</response>
```