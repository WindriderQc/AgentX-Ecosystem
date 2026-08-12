Object.assign(PerformanceDashboard, {
            // Render latency trend chart
            renderLatencyTrendChart(data) {
                const ctx = document.getElementById('latencyTrendsChart').getContext('2d');

                if (this.charts.latencyTrends) {
                    this.charts.latencyTrends.destroy();
                }

                const timestamps = data.map(d => new Date(d.timestamp).toLocaleTimeString());
                const p50Data = data.map(d => d.p50);
                const p95Data = data.map(d => d.p95);
                const p99Data = data.map(d => d.p99);

                this.charts.latencyTrends = new Chart(ctx, {
                    type: 'line',
                    data: {
                        labels: timestamps,
                        datasets: [
                            {
                                label: 'P50 (Median)',
                                data: p50Data,
                                borderColor: 'rgb(34, 197, 94)',
                                backgroundColor: 'rgba(34, 197, 94, 0.1)',
                                tension: 0.4,
                                fill: false,
                                borderWidth: 2
                            },
                            {
                                label: 'P95',
                                data: p95Data,
                                borderColor: 'rgb(251, 191, 36)',
                                backgroundColor: 'rgba(251, 191, 36, 0.1)',
                                tension: 0.4,
                                fill: false,
                                borderWidth: 2
                            },
                            {
                                label: 'P99',
                                data: p99Data,
                                borderColor: 'rgb(239, 68, 68)',
                                backgroundColor: 'rgba(239, 68, 68, 0.1)',
                                tension: 0.4,
                                fill: false,
                                borderWidth: 2
                            }
                        ]
                    },
                    options: {
                        responsive: true,
                        maintainAspectRatio: false,
                        plugins: {
                            legend: {
                                display: false
                            },
                            tooltip: {
                                mode: 'index',
                                intersect: false,
                                backgroundColor: 'rgba(0, 0, 0, 0.9)',
                                titleColor: '#7cf0ff',
                                bodyColor: '#e8edf5',
                                borderColor: 'rgba(255, 255, 255, 0.1)',
                                borderWidth: 1
                            }
                        },
                        scales: {
                            y: {
                                beginAtZero: true,
                                title: {
                                    display: true,
                                    text: 'Latency (ms)',
                                    color: '#93a0b5'
                                },
                                ticks: { color: '#93a0b5' },
                                grid: {
                                    color: 'rgba(255, 255, 255, 0.05)'
                                }
                            },
                            x: {
                                title: {
                                    display: true,
                                    text: 'Time',
                                    color: '#93a0b5'
                                },
                                ticks: {
                                    color: '#93a0b5',
                                    maxTicksLimit: 12
                                },
                                grid: {
                                    color: 'rgba(255, 255, 255, 0.05)'
                                }
                            }
                        }
                    }
                });
            },

            // Render percentile chart
            renderPercentileChart(data) {
                const ctx = document.getElementById('percentileChart').getContext('2d');

                if (this.charts.percentile) {
                    this.charts.percentile.destroy();
                }

                const labels = ['P50', 'P75', 'P90', 'P95', 'P99', 'P999'];
                const values = [
                    data.p50 || 0,
                    data.p75 || 0,
                    data.p90 || 0,
                    data.p95 || 0,
                    data.p99 || 0,
                    data.p999 || 0
                ];

                const colors = [
                    'rgba(34, 197, 94, 0.8)',
                    'rgba(34, 197, 94, 0.6)',
                    'rgba(251, 191, 36, 0.8)',
                    'rgba(251, 191, 36, 0.6)',
                    'rgba(239, 68, 68, 0.8)',
                    'rgba(239, 68, 68, 0.6)'
                ];

                this.charts.percentile = new Chart(ctx, {
                    type: 'bar',
                    data: {
                        labels: labels,
                        datasets: [{
                            label: 'Latency (ms)',
                            data: values,
                            backgroundColor: colors,
                            borderColor: colors.map(c => c.replace('0.8', '1').replace('0.6', '1')),
                            borderWidth: 1
                        }]
                    },
                    options: {
                        indexAxis: 'y',
                        responsive: true,
                        maintainAspectRatio: false,
                        plugins: {
                            legend: { display: false },
                            tooltip: {
                                backgroundColor: 'rgba(0, 0, 0, 0.9)',
                                titleColor: '#7cf0ff',
                                bodyColor: '#e8edf5',
                                borderColor: 'rgba(255, 255, 255, 0.1)',
                                borderWidth: 1
                            }
                        },
                        scales: {
                            x: {
                                beginAtZero: true,
                                title: {
                                    display: true,
                                    text: 'Latency (ms)',
                                    color: '#93a0b5'
                                },
                                ticks: { color: '#93a0b5' },
                                grid: { color: 'rgba(255, 255, 255, 0.05)' }
                            },
                            y: {
                                ticks: { color: '#93a0b5' },
                                grid: { color: 'rgba(255, 255, 255, 0.05)' }
                            }
                        }
                    }
                });
            },

            // Render throughput chart
            renderThroughputChart(data) {
                const ctx = document.getElementById('throughputChart').getContext('2d');

                if (this.charts.throughput) {
                    this.charts.throughput.destroy();
                }

                const timestamps = data.map(d => new Date(d.timestamp).toLocaleTimeString());
                const rps = data.map(d => parseFloat(d.rps || 0));
                const total = data.map(d => Number(d.requests_total || 0));

                this.charts.throughput = new Chart(ctx, {
                    type: 'line',
                    data: {
                        labels: timestamps,
                        datasets: [
                            {
                                label: 'Requests/sec',
                                data: rps,
                                borderColor: 'rgb(124, 240, 255)',
                                backgroundColor: 'rgba(124, 240, 255, 0.1)',
                                tension: 0.4,
                                yAxisID: 'y',
                                borderWidth: 2,
                                fill: true
                            },
                            {
                                label: 'Total Requests',
                                data: total,
                                borderColor: 'rgb(238, 176, 255)',
                                backgroundColor: 'rgba(238, 176, 255, 0.1)',
                                tension: 0.4,
                                yAxisID: 'y1',
                                borderWidth: 2,
                                fill: false
                            }
                        ]
                    },
                    options: {
                        responsive: true,
                        maintainAspectRatio: false,
                        interaction: {
                            mode: 'index',
                            intersect: false
                        },
                        plugins: {
                            legend: {
                                display: false
                            },
                            tooltip: {
                                backgroundColor: 'rgba(0, 0, 0, 0.9)',
                                titleColor: '#7cf0ff',
                                bodyColor: '#e8edf5',
                                borderColor: 'rgba(255, 255, 255, 0.1)',
                                borderWidth: 1
                            }
                        },
                        scales: {
                            y: {
                                type: 'linear',
                                display: true,
                                position: 'left',
                                beginAtZero: true,
                                title: {
                                    display: true,
                                    text: 'Requests/sec',
                                    color: '#7cf0ff'
                                },
                                ticks: { color: '#93a0b5' },
                                grid: { color: 'rgba(255, 255, 255, 0.05)' }
                            },
                            y1: {
                                type: 'linear',
                                display: true,
                                position: 'right',
                                beginAtZero: true,
                                title: {
                                    display: true,
                                    text: 'Total Requests',
                                    color: '#eeb0ff'
                                },
                                ticks: { color: '#93a0b5' },
                                grid: { drawOnChartArea: false }
                            },
                            x: {
                                title: {
                                    display: true,
                                    text: 'Time',
                                    color: '#93a0b5'
                                },
                                ticks: {
                                    color: '#93a0b5',
                                    maxTicksLimit: 12
                                },
                                grid: { color: 'rgba(255, 255, 255, 0.05)' }
                            }
                        }
                    }
                });
            }
});
