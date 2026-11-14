# Dashboard Business Logic Specification

## Overview

The Dashboard module provides real-time analytics and KPI metrics for EasyMod shop owners. It aggregates data from conversations, orders, products, and channels to give a comprehensive view of shop performance.

**Last Updated**: April 14, 2026  
**Module Path**: `src/modules/dashboard/`  
**Test Coverage**: 40+ test cases across 3 test files

---

## Architecture

```
dashboard/
├── dashboard.service.js       # Business logic & data aggregation
├── dashboard.analytics.js     # Analytics logging & aggregation
├── dashboard.controller.js    # HTTP request handlers
├── dashboard.routes.js        # Route definitions
├── dashboard.validator.js     # Input validation (Joi)
├── dashboard.entity.js        # Placeholder (analytics are computed)
└── __tests__/                 # Test suite
    ├── dashboard.service.test.js
    ├── dashboard.analytics.test.js
    └── dashboard.controller.test.js
```

---

## API Endpoints

### Core Dashboard

| Method | Endpoint | Description | Auth Required |
|--------|----------|-------------|---------------|
| GET | `/api/dashboard/` | Get dashboard KPI summary | Yes |
| GET | `/api/dashboard/chart` | Get orders chart data | Yes |
| GET | `/api/dashboard/queue` | Get today's action queue | Yes |
| GET | `/api/dashboard/metrics` | Legacy: KPI summary | Yes |
| GET | `/api/dashboard/:id` | Get metrics by shop ID | Yes |

### Analytics

| Method | Endpoint | Description | Auth Required |
|--------|----------|-------------|---------------|
| POST | `/api/dashboard/analytics/events` | Log analytics event | Yes |
| POST | `/api/dashboard/analytics/metrics` | Log raw metric | Yes |
| GET | `/api/dashboard/analytics/dashboard` | Get aggregated analytics | Yes |

---

## Business Logic

### 1. Dashboard Metrics (`getDashboardMetrics`)

**Purpose**: Calculate key performance indicators for a shop.

**Metrics Calculated**:

| Metric | Source | Calculation |
|--------|--------|-------------|
| `totalMessages` | Analytics.sum('total_messages') | Lifetime total |
| `activeProducts` | Product.count({ in_stock: true }) | Current inventory |
| `ordersToday` | Order.count({ created_at: today }) | Today's orders |
| `ordersInPeriod` | Order.count({ created_at: >= startOfPeriod }) | Period orders |
| `conversionRate` | ordersInPeriod / messagesInPeriod * 100 | Conversion % |
| `weeklyChange` | (current - previous) / previous * 100 | Weekly change % |

**Caching Strategy**:
- Cache Key: `dashboard:summary:{period}`
- TTL: 300 seconds (5 minutes)
- Invalidation: Manual via analytics events

**Flow**:
1. Check cache for existing data
2. If cache miss, run 9 parallel database queries
3. Calculate derived metrics (conversion rate, weekly change)
4. Store in cache
5. Return result

---

### 2. Chart Data (`getDashboardChart`)

**Purpose**: Generate daily order counts for chart visualization.

**Algorithm**:
1. Query orders grouped by date (SQL GROUP BY)
2. Build a Map of date → order count
3. Fill in missing dates with 0 orders
4. Return array of { date, orders } for each day in period

**Caching Strategy**:
- Cache Key: `dashboard:chart:{period}`
- TTL: 600 seconds (10 minutes)

---

### 3. Analytics Event Logging (`logEvent`)

**Purpose**: Track user interactions and system events.

**Event Types**:

| Event Type | Incremented Fields |
|------------|-------------------|
| `message` | total_messages |
| `ai_response` (with ai_model) | llm_calls |
| `response` (with cache_hit) | cache_hits |
| `message` (with keyword_match) | keyword_matches |
| Any (with cost_estimate) | cost_estimate |

**Atomic Operations**:
1. `findOrCreate` - Creates day-row if not exists
2. `increment` - SQL-level atomic increment
3. Cache invalidation

**Data Structure**:
```javascript
{
    shop_id: UUID,
    date: 'YYYY-MM-DD',
    total_messages: 0,
    llm_calls: 0,
    cache_hits: 0,
    keyword_matches: 0,
    cost_estimate: 0
}
```

---

### 4. Today's Queue (`getTodayQueue`)

**Purpose**: Real-time action queue for shop owners.

**Queue Items**:

| Item | Query | Description |
|------|-------|-------------|
| `unread_count` | Conversation.count({ status: 'unanswered' }) | Unread messages |
| `pending_payment_count` | Order.count({ payment_status: 'pending' }) | Awaiting payment |
| `ready_to_dispatch_count` | Order.count({ order_status: 'confirmed', not dispatched }) | Ready to ship |
| `at_risk_orders` | Order.findAll({ fulfillment_status: ['attempted', 'returned'] }) | RTO risk orders |

---

## Security Measures

### Rate Limiting
- **Window**: 15 minutes
- **Max Requests**: 100 per IP
- **Applied to**: All dashboard endpoints

### Authentication
- All routes require `authenticate` middleware
- JWT token validation
- Shop context required via `requireShop` middleware

---

## Performance Optimizations

### 1. Caching
- Summary cache: 5 minutes TTL
- Chart cache: 10 minutes TTL
- Cache invalidation on analytics events

### 2. Parallel Queries
- 9 queries run in parallel for metrics
- 3 queries run in parallel for queue

### 3. Lazy Loading
- Chart endpoint separate from summary
- Chart loads after KPI cards render

### 4. Database Optimizations
- `findOrCreate` with atomic increment
- SQL-level SUM queries (no memory aggregation)
- `raw: true` for read-only queries

---

## Data Flow

### Dashboard Load Flow

```
┌─────────────┐
│   Client    │
└──────┬──────┘
       │ GET /dashboard
       ▼
┌─────────────┐
│  Rate Limit │
└──────┬──────┘
       │
       ▼
┌─────────────┐
│  Auth Check │
└──────┬──────┘
       │
       ▼
┌─────────────┐     ┌──────────┐
│Cache Check? │────▶│  Cached  │
└──────┬──────┘     │  Return  │
       │ No         └──────────┘
       ▼
┌─────────────┐
│  DB Queries │ (Parallel)
└──────┬──────┘
       │
       ▼
┌─────────────┐
│  Calculate  │
│  Metrics    │
└──────┬──────┘
       │
       ▼
┌─────────────┐     ┌──────────┐
│  Cache Set  │────▶│ Response │
└─────────────┘     └──────────┘
```

### Analytics Event Flow

```
┌─────────────┐
│   Event     │
└──────┬──────┘
       │
       ▼
┌─────────────┐
│findOrCreate │
│ (day-row)   │
└──────┬──────┘
       │
       ▼
┌─────────────┐
│  increment  │ (SQL atomic)
└──────┬──────┘
       │
       ▼
┌─────────────┐
│Cache Invalid│
└──────┬──────┘
       │
       ▼
┌─────────────┐
│  Response   │
└─────────────┘
```

---

## Test Coverage

### Service Tests
- Cache hit/miss scenarios
- Metric calculations
- Null handling
- Division by zero protection
- Weekly change calculation

### Analytics Tests
- Event logging
- Metric logging
- Cache invalidation
- Aggregation queries

### Controller Tests
- HTTP response codes
- Error handling
- Legacy endpoint support
- Queue mapping

---

## Expected Behaviors

### What Should Happen

1. **Dashboard Load**: Fast (< 200ms) with cached data, slower on cache miss
2. **Analytics Events**: Logged atomically without race conditions
3. **Queue Updates**: Real-time counts reflecting current state
4. **Chart Data**: Complete dataset with zero-filled gaps

### What Should NOT Happen

1. **Data Leaks**: Shop A should never see Shop B's data
2. **Cache Staleness**: Analytics events invalidate cache immediately
3. **Race Conditions**: Concurrent increments should not lose counts
4. **Division by Zero**: Conversion rate should be 0 when no messages

---

## Configuration

### Cache TTL
```javascript
const SUMMARY_CACHE_TTL = 300;  // 5 minutes
const CHART_CACHE_TTL = 600;    // 10 minutes
```

### Rate Limiting
```javascript
{
    windowMs: 15 * 60 * 1000,  // 15 minutes
    max: 100  // requests per window
}
```

### Default Period
```javascript
const DEFAULT_PERIOD = 30;  // days
```

---

## Migration Notes

No database migrations required. The Analytics table is created via Sequelize sync.

---

## Related Modules

- **Auth**: JWT authentication for all endpoints
- **Cache**: Redis caching service
- **Entities**: Order, Product, Channel, Conversation, Analytics models
