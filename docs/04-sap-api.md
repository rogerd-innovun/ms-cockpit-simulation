# PO Cockpit — API for SAP

This is what the SAP side needs to call the cockpit: fetch the orders that are waiting, and post back the answer. It is the same exchange the folder drop does, over HTTPS.

| | |
|---|---|
| Base URL | `https://po-cockpit.onrender.com/api/integration/sap` (the hosted demo; a production deployment will have its own host) |
| Transport | HTTPS only. Never send the key over plain HTTP. |
| Authentication | One shared secret key, given to you separately (never by email or chat in clear if it can be avoided). Send it **any one** of three ways: an ordinary **HTTP Basic login** (user `sap`, the key as the password; the natural choice in ABAP), or `Authorization: Bearer <key>`, or `X-API-Key: <key>` |
| Address allow-list | If switched on, calls only work from your registered address(es). Tell us the public IP your SAP system calls from. |
| Format | JSON in, JSON out, UTF-8 |

## 1. Test the connection

`GET /ping` — checks the address, the key and the connection, and touches no order.

```
GET /api/integration/sap/ping
X-API-Key: <key>

200 {"ok":true,"system":"po-cockpit","time":"2026-10-05T10:00:00.000Z"}
```

## 2. Fetch the orders waiting for SAP

`GET /orders` (optional `?limit=1..100`, default 50) returns every approved order that SAP has not yet answered, oldest first. An order stays on the list **until you post its answer**, so if your job fails halfway you simply fetch it again. `GET /orders/{correlationId}` returns one.

```json
{
  "orders": [
    {
      "correlationId": "PO-9F54E6E480564949BECE0E856F067D0D",
      "attempt": 1,
      "header": {
        "poNumber": "APX-118276",
        "poDate": "2026-09-18",
        "customerCode": "C-3305",
        "customerName": "APEX FASTENER SUPPLY INC.",
        "shipTo": "…",
        "billTo": "…",
        "currency": "USD",
        "requestedDeliveryDate": "2026-10-18",
        "paymentTerms": "Net 30",
        "incoterms": "FOB",
        "poTotalValue": "4942.00"
      },
      "lines": [
        {
          "lineNumber": 1,
          "materialCode": "MAT-1042",
          "customerMaterialNumber": "X9",
          "description": "Hex bolt M10x40",
          "quantity": "4000",
          "uom": "EA",
          "unitPrice": "0.63",
          "lineNetValue": "2520.00",
          "deliveryDate": "2026-10-18",
          "plant": "1000"
        }
      ]
    }
  ],
  "problems": []
}
```

- Dates are `YYYY-MM-DD` and numbers use `.` as the decimal point and no thousands separator, whatever the customer's PO used. (Both can be changed to SAP's own formats, for example `YYYYMMDD` and a decimal comma, in the cockpit's settings.)
- `correlationId` identifies the order for its whole life. `attempt` goes up by one each time a rejected order is corrected and sent again. **Send both back with your answer.**
- `problems` lists any order the cockpit could not put into these formats, with the reason. It never hides one silently.

## 3. Post the answer

`POST /results` — one call per order.

Success:
```json
{ "correlationId": "PO-9F54E6E480564949BECE0E856F067D0D", "attempt": 1, "status": "SUCCESS", "soNumber": "4500387184" }
```

Rejection:
```json
{ "correlationId": "PO-9F54E6E480564949BECE0E856F067D0D", "attempt": 1, "status": "ERROR",
  "errorCode": "MATERIAL_NOT_FOUND", "errorMessage": "Material MAT-1042 does not exist in plant 1000" }
```

Optional: `sapTimestamp`. Field names may be camelCase (`correlationId`) or ABAP style (`CORRELATION_ID`); `status` is case-insensitive. A `SUCCESS` without `soNumber` is refused.

| Answer | Meaning | What to do |
|---|---|---|
| `200 {"accepted":true,"applied":true}` | The order is now `SO_CREATED` (or `FAILED` with your error shown to the user) | Done |
| `200 {"accepted":true,"applied":false,"duplicate":true}` | You already sent exactly this | Done; stop retrying |
| `400` `VALIDATION_ERROR` | The body is JSON but incomplete or wrong (a missing `correlationId`, an unknown `status`, a `SUCCESS` with no `soNumber`). The message names the field | Fix the field named; retrying will not help |
| `400` `BODY_NOT_JSON` | The `Content-Type` says JSON but the body is something else (for example `sales_orders=4500…`). The message shows how the body started and a correct example | Send one JSON object as shown above; retrying will not help |
| `415` `UNSUPPORTED_MEDIA_TYPE` | The body was sent as form fields or plain text instead of JSON | Set `Content-Type: application/json` and send a JSON object |
| `401` | Missing or wrong key | Check the key |
| `403` | Calling from an address that is not allowed | Ask us to add your address |
| `404 UNKNOWN_CORRELATION_ID` | No order has that ID. Kept on file and our operations team is alerted | Check the ID |
| `409 STALE_ATTEMPT` | The answer is for an earlier attempt than the order's current one. Kept on file, not applied | Fetch the order again and answer its current attempt |
| `409 NOT_WAITING_FOR_RESULT` | The order is not waiting for an answer (already answered, cancelled, or sent back). Kept on file, not applied | Nothing to do, unless you created an order you should not have: tell us |
| `429` | Too many wrong keys from your address; wait a few minutes | |
| `5xx` | Our side; the answer was **not** recorded | Retry later. Retrying is safe: the same answer is recognised as a duplicate |

An answer that arrives after we gave up waiting (our timeout is 60 minutes) is still accepted for the current attempt and completes the order.

## 4. How often

Fetch every 1–5 minutes. There is no need to remember what you have already fetched: an order leaves the list when you answer it.

## 5. If your answer is not JSON yet: the capture address

`POST /echo` takes **any** body (JSON, form fields, text, an internal table written out as text) and keeps it exactly as sent, without applying anything to any order. Point your program at it first, with the same login as everything else, and the cockpit side can then write the mapping from a real example instead of a description.

```
POST /api/integration/sap/echo
200 {"received":true,"bytes":74,"kind":"delimited","delimiter":"tab","headers":{…},"preview":"VBELN\tBSTNK\t…"}
```

- `kind` is the cockpit's guess at the format: `json`, `form` (`name=value`, as in `sales_orders=…`, with each field's own kind listed), `delimited` (rows split by tab, `;`, `|` or `,`), `xml`, `text`, `binary` or `empty`. The reply also echoes the headers that matter (never the key) and the first 2,000 characters.
- `GET /echo` returns the latest 20 captures, newest first, with the full text (up to 20,000 characters each). They are held in the server's memory, so a restart clears them; every capture is also written to the server log as `SAP API capture`.
- It needs the key, like every other address here, and a body over 1 MB is refused. Switch it off with `SAP_API_CAPTURE=false` once the real format is handled.
- Please send a few real rows, not one, and include any fields that are empty in your real data.

## 6. From ABAP, in outline

Create an HTTP client for the URL (SM59 or `cl_http_client=>create_by_url`), log in with `client->authenticate( username = 'sap' password = lv_key )` (or set `request->set_header_field( name = 'X-API-Key' value = lv_key )`), `set_method( 'GET' )` for the list and `'POST'` with `Content-Type: application/json` for answers, and (de)serialise with `/ui2/cl_json`. Keep the key in secure storage (SSFA / a secure parameter), not in the program.
