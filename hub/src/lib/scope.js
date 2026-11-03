'use strict';

// What a client person may see. A person is either "all projects" (the whole company's work) or limited to the
// projects they were invited for. Everything a client page shows is filtered through this.
const { db } = require('../db');

async function clientScope(user) {
  if (user.all_projects) return { all: true, ids: [] };
  const ids = await db('project_members as pm').join('projects as p', 'p.id', 'pm.project_id')
    .where({ 'pm.user_id': user.id, 'p.client_id': user.client_id }).pluck('p.id');
  return { all: false, ids };
}

/** Limits a query to the allowed projects, by the column that holds the project id. */
const inScope = (query, scope, column = 'id') => (scope.all ? query : query.whereIn(column, scope.ids.length ? scope.ids : [0]));

/** Support requests: a limited person sees the ones they opened, or ones about their projects. */
const ticketsInScope = (query, scope, user, projectCol = 'project_id', userCol = 'created_by') => (scope.all ? query
  : query.where((w) => w.where(userCol, user.id).orWhereIn(projectCol, scope.ids.length ? scope.ids : [0])));

module.exports = { clientScope, inScope, ticketsInScope };
