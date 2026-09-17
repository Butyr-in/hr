// core/parser/xmlParser.js
// ============================================================
// Парсер XML
// ============================================================

// ===== ФУНКЦИЯ ОЧИСТКИ СУММ ОТ СИМВОЛОВ ВАЛЮТ =====
function cleanSum(sumStr) {
    if (!sumStr) return 0;
    if (typeof sumStr === 'number') {
        if (isNaN(sumStr)) return 0;
        return sumStr;
    }
    const cleaned = String(sumStr)
    .replace(/,/g, '.') // заменяем запятую на точку для европейского формата
    .replace(/[€$₽\s]/g, ''); // удаляем валюту и пробелы
    const result = parseFloat(cleaned);

    return isNaN(result) ? 0 : result;
}

// ===== ПАРСИМ ВСЕ РАЗДАЧИ =====
function parseAllHands(xmlString, isAmericanDateFormat = false) {
    if (!xmlString) return null;

    // Подготовка: если файл содержит несколько <root>, оборачиваем его в один <wrapper>
    // и вырезаем лишние открывающие/закрывающие теги root
    let preparedXml = xmlString.trim();
    if ((preparedXml.match(/<root>/g) || []).length > 1) {
        // Удаляем все <root> и </root>
        preparedXml = preparedXml.replace(/<root>/g, '').replace(/<\/root>/g, '');
        // Оборачиваем в один легальный корневой тег
        preparedXml = `<root>${preparedXml}</root>`;
    }

    const parser = new DOMParser();
    const xmlDoc = parser.parseFromString(preparedXml, 'text/xml');

    const parseError = xmlDoc.querySelector('parsererror');
    if (parseError) {
        console.error('XML parsing error:', parseError.textContent);
        return null;
    }

    const gameNodes = xmlDoc.querySelectorAll('game');
    const hands = [];

    for (let i = 0; i < gameNodes.length; i++) {
        // Передаем флаг формата даты дальше в parseGame
        const hand = parseGame(gameNodes[i], isAmericanDateFormat);
        if (hand) {
            hands.push(hand);
        }
    }

    return hands;
}


// ===== ПАРСИМ ОДНУ РАЗДАЧУ (С УЧЕТОМ ДЛИТЕЛЬНОСТИ И КАРТ) =====
function parseGame(gameNode, isAmericanDateFormat = false) {
    const gamecode = gameNode.getAttribute('gamecode');
    if (!gamecode) return null;

    const generalNode = gameNode.querySelector('general');
    if (!generalNode) return null;

    const startDateStr = generalNode.querySelector('startdate')?.textContent;
    if (!startDateStr) return null;

    const playersNode = generalNode.querySelector('players');
    if (!playersNode) return null;

    const playerNodes = playersNode.querySelectorAll('player');
    if (playerNodes.length === 0) return null;

    const durationStr = generalNode.querySelector('duration')?.textContent || "00:00:00";
    const durationParts = durationStr.split(':').map(Number);
    
    const hours = isNaN(durationParts[0]) ? 0 : durationParts[0];
    const minutes = isNaN(durationParts[1]) ? 0 : durationParts[1];
    const seconds = isNaN(durationParts[2]) ? 0 : durationParts[2];
    const durationMs = ((hours * 3600) + (minutes * 60) + seconds) * 1000;

    const startDate = parseDateTime(startDateStr, isAmericanDateFormat);
    const endDate = new Date(startDate.getTime() + durationMs);

    // Находим большого блайнда
    let bigBlind = 0;
    const round0 = gameNode.querySelector('round[no="0"]');
    if (round0) {
        const actions0 = round0.querySelectorAll('action');
        const bbType = typeof ACTION_TYPES !== 'undefined' ? ACTION_TYPES.BB : 2; 

        for (let a = 0; a < actions0.length; a++) {
            const action = actions0[a];
            const type = parseInt(action.getAttribute('type'));
            if (type === bbType) {
                bigBlind = cleanSum(action.getAttribute('sum'));
                break;
            }
        }
    }

    // Собираем карманные карты игроков из раунда 1
    const playerCardsMap = {};
    const round1 = gameNode.querySelector('round[no="1"]');
    if (round1) {
        const cardsNodes = round1.querySelectorAll('cards[type="Pocket"]');
        for (let c = 0; c < cardsNodes.length; c++) {
            const pName = cardsNodes[c].getAttribute('player');
            const pCards = cardsNodes[c].textContent ? cardsNodes[c].textContent.trim() : '';
            if (pName && pCards && pCards !== 'X X') {
                playerCardsMap[pName] = pCards; // Сохраняем "D8 DJ"
            }
        }
    }

    const actions = parseActions(gameNode);
    
    const players = Array.from(playerNodes).map(node => {
        const name = node.getAttribute('name');
        const win = cleanSum(node.getAttribute('win'));
        const bet = cleanSum(node.getAttribute('bet'));
        const rake = cleanSum(node.getAttribute('rakeamount') || node.getAttribute('rake'));
        
        return {
            name: name,
            win: win,
            bet: bet,
            rake: rake,
            cards: playerCardsMap[name] || null // Привязываем карты к игроку
        };
    });

    return {
        gamecode: gamecode,
        startDate: startDate,
        endDate: endDate,
        limit: Math.round(bigBlind * 100),
        players: players,
        actions: actions
    };
}



// ===== ПАРСИМ ДЕЙСТВИЯ =====
function parseActions(gameNode) {
    const allActions = [];
    const roundNodes = gameNode.querySelectorAll('round');

    for (let r = 0; r < roundNodes.length; r++) {
        const roundNode = roundNodes[r];
        const roundNo = parseInt(roundNode.getAttribute('no') || 0);
        const actions = roundNode.querySelectorAll('action');

        for (let a = 0; a < actions.length; a++) {
            const action = actions[a];
            const player = action.getAttribute('player');
            const type = parseInt(action.getAttribute('type') || 0);
            const sum = cleanSum(action.getAttribute('sum'));

            allActions.push({
                player: player,
                type: type,
                sum: sum,
                round: roundNo
            });
        }
    }

    return allActions;
}

function calculateResult(players, playerName) {
    const parseMoney = (val) => {
        if (!val) return 0;
        if (typeof val === 'number') return val;
        return parseFloat(val.replace(/[^\d.-]/g, '')) || 0;
    };

    const targetPlayer = players.find(p => p.name === playerName);
    if (!targetPlayer) return 0;

    const targetWin = parseMoney(targetPlayer.win);
    const targetBet = parseMoney(targetPlayer.bet);
    const targetRake = parseMoney(targetPlayer.rakeamount || targetPlayer.rake);

    // --- АЛГОРИТМ РАСЧЕТА ЭФФЕКТИВНЫХ СТАВОК (БЕЗ ПРИВЯЗКИ К WIN) ---
    // Собираем все исходные ставки за столом
    const allBets = players.map(p => parseMoney(p.bet));
    
    // Вычисляем, сколько РЕАЛЬНО у каждого игрока ушло в банк (после возврата uncalled bet)
    let totalUncalledReturn = 0;
    let effectiveInvested = targetBet;

    // Находим максимальную ставку и вторую по величине
    const maxBet = Math.max(...allBets);
    const sortedBets = [...allBets].sort((a, b) => b - a);
    const secondMaxBet = sortedBets[1] || 0;

    // Если текущий игрок поставил больше всех, то разница между его ставкой 
    // и второй максимальной ставкой за столом — это чистый возврат (uncalled bet)
    if (targetBet === maxBet && maxBet > secondMaxBet) {
        const uncalledBet = maxBet - secondMaxBet;
        effectiveInvested = targetBet - uncalledBet;
    }

    // --- ФИНАЛЬНЫЙ РАСЧЕТ РЕЗУЛЬТАТА ---
    if (targetWin === 0) {
        // Игрок проиграл: возвращаем его реальные потери (для RedButyrin это будет -16.34)
        return -effectiveInvested;
    } else {
        // Игрок выиграл (или взял кэшаут): Чистый профит + его рейк для DataManager
        const netProfit = targetWin - effectiveInvested;
        return netProfit + targetRake;
    }
}



// Добавляем флаг (по умолчанию false, т.е. европейский формат DD-MM-YYYY)
function parseDateTime(dateStr, isAmericanDateFormat = false) {
    if (!dateStr) return new Date();
    
    dateStr = dateStr.trim();
    
    // Пробуем найти время
    let timeParts = [0, 0, 0];
    const timeMatch = dateStr.match(/(\d{1,2}):(\d{2}):(\d{2})/);
    if (timeMatch) {
        timeParts = [parseInt(timeMatch[1]), parseInt(timeMatch[2]), parseInt(timeMatch[3])];
        dateStr = dateStr.replace(timeMatch[0], '').trim();
    }
    
    // Извлекаем числа даты
    const numbers = dateStr.match(/\d+/g);
    if (!numbers || numbers.length < 3) {
        console.warn('⚠️ Не удалось распарсить дату:', dateStr);
        return new Date();
    }
    
    let year, month, day;
    
    // Определяем формат по позиции 4-значного года
    if (numbers[0].length === 4) {
        // Год в начале → YYYY-MM-DD
        year = parseInt(numbers[0]);
        month = parseInt(numbers[1]);
        day = parseInt(numbers[2]);
    } else if (numbers[2].length === 4) {
        // Год в конце → строго определяем формат по флагу
        if (isAmericanDateFormat) {
            month = parseInt(numbers[0]);
            day = parseInt(numbers[1]);
        } else {
            day = parseInt(numbers[0]);
            month = parseInt(numbers[1]);
        }
        year = parseInt(numbers[2]);
    } else {
        // Если ничего не подошло — пробуем стандартный new Date()
        const d = new Date(dateStr);
        if (!isNaN(d.getTime())) {
            return d;
        }
        console.warn('⚠️ Не удалось распарсить дату:', dateStr);
        return new Date();
    }
    
    return new Date(year, month - 1, day, timeParts[0], timeParts[1], timeParts[2]);
}