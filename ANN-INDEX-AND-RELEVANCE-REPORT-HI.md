# IndexedDB ANN और Relevance Evaluation रिपोर्ट

## क्या बदला

`src/lib/vectorIndex.ts` में बड़े corpus के लिए exact full-corpus vector scan को versioned **sparse random-hyperplane LSH** candidate index से बदला गया है। IndexedDB का `vectors` store authoritative data बना रहता है; bucket keys केवल derived acceleration data हैं।

- हर vector को 12 independent hash tables में रखा जाता है; हर table की signature 12 projection bits की होती है।
- Query retrieval हर table का exact bucket और सबसे निकट decision-boundary bit flip वाला पड़ोसी bucket पढ़ता है (अधिकतम 24 bucket probes)।
- IndexedDB के `multiEntry` index से केवल उन buckets के records लोड होते हैं; फिर **exact cosine similarity** से re-rank किया जाता है। गलत/पुराने model, version, dimension, live-file filter और `topK` के मौजूदा guards लागू रहते हैं।
- 128 या कम vectors के corpus पर existing exact search रखा है—छोटे corpus में ANN index overhead नहीं जोड़ा जाता।
- पहले ANN query पर पुराने v1 records का index corpus-scoped, streaming IndexedDB cursor से backfill होता है। Migration metadata में algorithm version है; index बदले तो derived buckets फिर बनेंगे।
- बड़े corpus में यदि ANN candidate set खाली हो या सभी candidates `minScore` के कारण reject हो जाएँ, तो `searchNeuralByEmbedding` स्वतः पूरे corpus पर exact cosine scan करता है। इससे partial/empty ANN index के कारण silent empty result नहीं आता। `onMetrics` में `usedExactFallback` और `fallbackReason` (`empty-candidates` या `no-qualified-hits`) मिलते हैं।
- बड़े corpus का derived index अब browser idle समय में warm-up हो सकता है। Web Locks API उपलब्ध होने पर अलग-अलग tabs एक ही corpus migration को serialize करते हैं; unsupported browsers में पुराना transaction fallback चलता रहता है।
- Search metrics केवल local diagnostics ring में रखे जाते हैं: corpus/vector counts, candidate counts, fallback reason और latency। Query text, file body, embedding vector और token log नहीं किए जाते।
- नए vectors embedding/write transaction में bucket keys समेत सहेजे जाते हैं। API embedding failure पर पहले की तरह valid vectors नहीं हटते।

## Reproducible benchmark

चलाएँ:

```bash
npm ci
npm run evaluate:relevance
```

यह test `src/lib/__tests__/vectorIndex.relevance.test.ts` में 8 labeled topical clusters × 10 documents (**80 vectors, 8 queries**) बनाता है। Legacy vectors में ANN metadata जान-बूझकर नहीं दिया जाता, इसलिए वही test migration और ANN retrieval भी जाँचता है। Exact cosine scan को oracle बनाकर ANN top-10 से तुलना होती है। ANN pathway को इस छोटे fixture पर `exactSearchThreshold: 0` देकर जान-बूझकर force किया गया है; सामान्य app configuration में 80 vectors अभी भी default exact path पर जाते हैं। Test अलग से इस default exact path को भी जाँचता है।

वर्तमान परिणाम:

| माप | परिणाम |
|---|---:|
| Queries / vectors | 8 / 80 |
| Precision@5 (topic relevance) | 1.00 |
| Recall@10 (topic relevance) | 1.00 |
| MRR (पहले सही topic का reciprocal rank) | 1.00 |
| ANN candidate set का औसत हिस्सा | 12.7% |
| इस fixture में cosine-score candidate घटाव | 87% |
| ANN top-10 बनाम exact top-10 overlap | सभी queries के लिए कम-से-कम 0.80; fixture पर पूर्ण overlap |

Test report हर run पर stdout में `ANN_RELEVANCE_REPORT` JSON के रूप में आता है। यही test पूरी `npm test` suite में भी शामिल है।

## सीमाएँ और सही अर्थ

यह **deterministic algorithm regression fixture** है: vectors को अलग topical clusters के रूप में निर्धारित किया गया है। इससे IndexedDB migration, candidate-only retrieval, exact reranking और code regression जाँचे जाते हैं; यह असली Gemini embeddings, multilingual queries, किसी उपयोगकर्ता की Google Drive या बड़े वास्तविक corpus की relevance का प्रमाण **नहीं** है। इसीलिए hybrid ranking weights provisional ही रहते हैं। Real-corpus quality के लिए सहमति से चुने गए query/document relevance labels और live embedding outputs चाहिए; Drive सामग्री इस repo में नहीं डाली जाती।

87% का आँकड़ा 80-vector fixture में **candidate reduction** है, end-to-end latency या बड़े corpus पर तय performance guarantee नहीं। पहले ANN query को पुराने vectors का derived index backfill करना पड़ सकता है। सामान्य ANN path में candidate miss होने पर exact fallback correctness बचाता है, लेकिन उस query की latency exact scan जितनी हो सकती है। Candidate overlap और size वास्तविक embedding distribution, corpus और LSH parameters पर निर्भर होंगे। यदि fallback rate या latency अधिक मिले तो exact-search threshold और LSH configuration को labeled real-corpus evaluation से tune करें।

## बदलाव / validation स्थिति

- `src/lib/vectorIndex.ts` — ANN index, streaming legacy backfill, candidate retrieval और metrics callback
- `src/lib/__tests__/vectorIndex.relevance.test.ts` — deterministic fixture, exact-oracle comparison और retrieval metrics
- `package.json` — `npm run evaluate:relevance`
- `README.md` — search architecture और benchmark limitation

इस बदलाव पर चलाए गए checks: `npm run lint`, `npm test` (**70 tests passed**), `npm run build`, `npm run check:bundle`, और `git diff --check`।
