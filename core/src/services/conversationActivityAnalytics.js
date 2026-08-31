'use strict';

function messageObservedAtExpression(variable = '$$message') {
  return { $ifNull: [`${variable}.timestamp`, `${variable}.createdAt`] };
}

function conversationActivityFilter(fromDate, toDate) {
  const range = { $gte: fromDate, $lte: toDate };
  return {
    $or: [
      { 'messages.timestamp': range },
      { 'messages.createdAt': range }
    ]
  };
}

function activeMessagesExpression(fromDate, toDate) {
  const observedAt = messageObservedAtExpression();
  return {
    $filter: {
      input: { $ifNull: ['$messages', []] },
      as: 'message',
      cond: {
        $and: [
          { $gte: [observedAt, fromDate] },
          { $lte: [observedAt, toDate] }
        ]
      }
    }
  };
}

function activeMessageCostExpression(input = '$activeMessages') {
  return {
    $sum: {
      $map: {
        input,
        as: 'message',
        in: {
          $cond: [
            { $eq: ['$$message.role', 'assistant'] },
            { $ifNull: ['$$message.cost.totalCost', 0] },
            0
          ]
        }
      }
    }
  };
}

function activityDayPipeline(fromDate, toDate) {
  const observedAt = { $ifNull: ['$messages.timestamp', '$messages.createdAt'] };
  return [
    { $match: conversationActivityFilter(fromDate, toDate) },
    { $unwind: '$messages' },
    { $match: { $expr: { $and: [
      { $gte: [observedAt, fromDate] },
      { $lte: [observedAt, toDate] }
    ] } } },
    { $group: {
      _id: { $dateToString: { format: '%Y-%m-%d', date: observedAt } },
      conversationIds: { $addToSet: '$_id' },
      messages: { $sum: 1 },
      totalCost: {
        $sum: {
          $cond: [
            { $eq: ['$messages.role', 'assistant'] },
            { $ifNull: ['$messages.cost.totalCost', 0] },
            0
          ]
        }
      }
    } },
    { $project: {
      _id: 0,
      date: '$_id',
      conversations: { $size: '$conversationIds' },
      messages: 1,
      totalCost: 1,
      avgCostPerConversation: {
        $cond: [
          { $gt: [{ $size: '$conversationIds' }, 0] },
          { $divide: ['$totalCost', { $size: '$conversationIds' }] },
          0
        ]
      }
    } },
    { $sort: { date: 1 } }
  ];
}

module.exports = {
  activeMessageCostExpression,
  activeMessagesExpression,
  activityDayPipeline,
  conversationActivityFilter,
  messageObservedAtExpression
};
