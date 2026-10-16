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
| `400` | The body is incomplete or malformed. "… is not valid JSON" means the body is not JSON at all (for example `sales_orders=4500…`), or the `Content-Type` says JSON while the body is something else | Send a JSON object as shown above, with `Content-Type: application/json`; retrying will not help |
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

## 5. From ABAP, in outline

Create an HTTP client for the URL (SM59 or `cl_http_client=>create_by_url`), log in with `client->authenticate( username = 'sap' password = lv_key )` (or set `request->set_header_field( name = 'X-API-Key' value = lv_key )`), `set_method( 'GET' )` for the list and `'POST'` with `Content-Type: application/json` for answers, and (de)serialise with `/ui2/cl_json`. Keep the key in secure storage (SSFA / a secure parameter), not in the program.
