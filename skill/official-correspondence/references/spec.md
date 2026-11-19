# Spec fields

Every field is optional unless the gate names it. Lines are arrays of strings.

| Field | For | Meaning |
|---|---|---|
| `kind` | all, required | `letter`, `circular`, `notice`, `memo`, `meeting`, `order`, `leave` |
| `house` | all | `ugc-lk`, `pa-lk`, `ministry-lk`, `university-lk` (default), `bd` |
| `letterhead` | all | Centred lines, first one bold and larger. A line may be `{"text","bold","size"}`. Leave out when printing on letterhead paper |
| `logo`, `logo_width_cm` | all | Path of an image the user supplied. Never another image |
| `my_no`, `your_no` | all | Reference numbers from the user. Missing `my_no` prints a placeholder |
| `date`, `date_style` | all | `YYYY-MM-DD`; style `written`, `dotted` or `iso-dotted` overrides the house |
| `number`, `series`, `issuer_address` | circular | `02/2021(VIII)`; the wording before the number; the office block beside it |
| `to` | most | One addressee per line |
| `from` | memo | Sender's post |
| `through` | leave | Offices it goes through, in order |
| `salutation`, `no_salutation` | letter, leave | `true` for a letter to a list of posts |
| `subject`, `subject_upper` | most | Plain text; `subject_upper: false` keeps the case |
| `body` | all | Strings are paragraphs; `{"items":[…], "labels":"alpha"\|"roman"}`; `{"table":[[…],[…]]}`, first row bold |
| `numbered`, `signature` | all | Override the house: `true`/`false`; `left`/`right` |
| `date_of_meeting`, `time`, `duration`, `venue`, `agenda` | meeting | Details after the body |
| `title` | notice, meeting, order | Replaces `NOTICE`, `NOTICE OF MEETING`, `Office Order` |
| `leave_type`, `address_on_leave`, `recommenders` | leave | `abroad` turns on the attachment check; address; one sign-off line per office |
| `enclosures` | all | Numbered list |
| `closing`, `authority` | all | "Yours faithfully,"; "With the approval of the competent authority," |
| `signer` | all | `{name, designation, office, phone, fax, email}`. Missing name or post prints a placeholder |
| `distribution` | bd | List under `Distribution:` |
| `copies`, `copies_heading` | all | Numbered list, under the house's heading unless replaced |
| `file_no` | all | Last line, `File No: …` |
| `font` | all | `{latin, size}`. Default Times New Roman 12 |
| `page_numbers` | all | `true` forces the footer |

## Example: UGC circular

```json
{"kind": "circular", "house": "ugc-lk", "number": "[Circular No.]",
 "letterhead": ["UNIVERSITY GRANTS COMMISSION"], "date": "2026-10-31",
 "to": ["Vice-Chancellors of all Universities", "Rectors of Campuses"],
 "subject": "Submission of documents to the portal",
 "body": ["Your attention is drawn to…", "Please take action accordingly."],
 "signer": {"name": "[Name]", "designation": "Secretary"},
 "copies": ["Chairman", "Vice-Chairman"]}
```
