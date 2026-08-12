# Alert Analytics Dashboard

## Quick Start

Access the dashboard at: `/alert-analytics.html`

## Files Created

### Frontend
1. **`/public/alert-analytics.html`**
   - Main HTML page for the analytics dashboard
   - Includes Chart.js library and custom styles
   - Responsive design with dark theme

2. **`/public/js/alert-analytics.js`**
   - JavaScript module implementing all visualizations
   - Uses Chart.js for rendering
   - Handles data fetching and transformation

### Backend
3. **`/routes/alerts.js`** (Extended)
   - Added new endpoint: `GET /api/alerts/statistics`
   - Comprehensive MongoDB aggregation pipeline
   - Returns formatted analytics data

### Documentation
4. **`/docs/ALERT_ANALYTICS_DASHBOARD.md`**
   - Complete usage guide
   - API documentation
   - Troubleshooting tips
   - Customization instructions

## Features Implemented

### 7 Visualizations

1. **Alert Volume Over Time** (Line Chart)
   - Time-series data by severity
   - Automatic time bucketing
   - Responsive to time range selection

2. **Alerts by Severity** (Doughnut Chart)
   - Distribution of alert severities
   - Percentage breakdown
   - Color-coded by severity

3. **Top Alerting Components** (Horizontal Bar Chart)
   - Top 10 sources of alerts
   - Identifies noisy components

4. **Alert Status Distribution** (Bar Chart)
   - Active, Acknowledged, Resolved, Suppressed
   - Current system state overview

5. **Delivery Success Rate** (Bar Chart)
   - Success percentage by channel
   - Email, Slack, Webhook, DataAPI

6. **Alert Recurrence Heatmap** (Bar Chart)
   - Day of week × Hour of day
   - Identifies temporal patterns

7. **Key Metrics Cards**
   - Total Alerts
   - Critical Alerts
   - MTTA (Mean Time To Acknowledge)
   - MTTR (Mean Time To Resolution)

## API Endpoint

### GET /api/alerts/statistics

**Query Parameters:**
- `from`: ISO 8601 date (required)
- `to`: ISO 8601 date (optional, defaults to now)

**Response:**
```json
{
  "status": "success",
  "data": {
    "summary": { ... },
    "bySeverity": { ... },
    "byStatus": { ... },
    "bySource": { ... },
    "byRule": [ ... ],
    "deliveryStats": [ ... ],
    "timeSeries": [ ... ],
    "heatmap": [ ... ],
    "generatedAt": "2026-01-02T20:30:00.000Z"
  }
}
```

## Usage

```javascript
// Initialize the dashboard
import AlertAnalytics from './js/alert-analytics.js';

const analytics = new AlertAnalytics({
    containerId: 'alert-analytics-container',
    refreshInterval: 60000, // 1 minute
    timeRange: 7 // 7 days
});

await analytics.init();
```

## Customization

### Change Time Range
```javascript
// In HTML select dropdown or JavaScript
analytics.timeRange = 30; // 30 days
analytics.refresh();
```

### Change Colors
```javascript
// In alert-analytics.js
this.colors = {
    critical: '#dc3545',
    high: '#fd7e14',
    warning: '#ffc107',
    // ... customize as needed
};
```

### Add Custom Metrics
1. Extend MongoDB aggregation in `/routes/alerts.js`
2. Add metric card in HTML layout
3. Update `updateMetrics()` in JavaScript

## Dependencies

- **Chart.js**: v4.4.4 (loaded from CDN)
- **Font Awesome**: v6.4.0 (icons)
- **MongoDB**: Aggregation pipeline for analytics

## Browser Support

- Chrome 90+
- Firefox 88+
- Safari 14+
- Edge 90+

Requires ES6 module support.

## Performance

- **Efficient MongoDB Aggregation**: Single query for all data
- **Client-Side Rendering**: Chart.js for smooth animations
- **Auto-Refresh**: Configurable interval (default 60s)
- **Responsive Design**: Works on desktop and tablet

## Recommended MongoDB Indexes

```javascript
// Add these indexes for optimal performance
db.alerts.createIndex({ createdAt: -1 });
db.alerts.createIndex({ severity: 1, status: 1 });
db.alerts.createIndex({ source: 1, createdAt: -1 });
```

## Navigation

- **From Alerts Dashboard**: Click "Analytics" button
- **From Analytics**: Click "Back to Alerts Dashboard" link
- **Direct URL**: `/alert-analytics.html`

## Testing

```bash
# Start the server
npm start

# Navigate to
http://localhost:3080/alert-analytics.html

# Check console for errors
# Verify charts render correctly
# Test time range selector
# Test refresh button
```

## Troubleshooting

### Charts Not Rendering
1. Check browser console for errors
2. Verify Chart.js is loaded
3. Check API endpoint returns data

### No Data
1. Ensure alerts exist in database
2. Check selected time range
3. Verify MongoDB connection

### Performance Issues
1. Add recommended indexes
2. Reduce time range
3. Check MongoDB server performance

## Future Enhancements

- [ ] Export charts as PNG/PDF
- [ ] Comparison view (week over week)
- [ ] Real-time WebSocket updates
- [ ] Custom date range picker
- [ ] Alert forecasting
- [ ] Anomaly detection
- [ ] Email scheduled reports

## Related Files

- `/public/alerts.html` - Main alerts dashboard
- `/public/js/alerts-dashboard.js` - Alerts management
- `/routes/alerts.js` - API routes
- `/models/Alert.js` - Alert model
- `/docs/API_ROUTES_IMPLEMENTATION.md` - API docs

## Support

For issues:
1. Check browser console
2. Review server logs
3. Verify MongoDB indexes
4. See full documentation in `/docs/ALERT_ANALYTICS_DASHBOARD.md`
